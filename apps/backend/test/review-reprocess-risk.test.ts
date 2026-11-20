import { createHarness, openReview, registerAccount, type Harness } from './helpers';
import { AuditRepository, JobsRepository } from '../src/repositories/system-repo';
import { ExtractionsRepository } from '../src/repositories/document-repo';

describe('review/reprocess isolation', () => {
  let harness: Harness;
  beforeEach(async () => {
    harness = await createHarness();
  });
  afterEach(async () => {
    await harness.services.worker.stop();
    await harness.close();
  });

  it('supersedes old reviews and blocks open, corrections, approval, rejection and bulk approval while queued', async () => {
    const account = await registerAccount(harness);
    const upload = await harness.api.upload(account.accessToken);
    const documentId = upload.json<{ id: string }>().id;
    await harness.services.worker.drain();
    const review = await openReview(harness, account, documentId);
    const reprocess = await harness.api.json('POST', `/api/v1/documents/${documentId}/reprocess`, {
      token: account.accessToken,
    });
    expect(reprocess.statusCode).toBe(202);
    expect(
      await harness.db.one('SELECT status FROM reviews WHERE id = ?', [review.reviewId]),
    ).toEqual({ status: 'superseded' });
    const requests = await Promise.all([
      harness.api.json('POST', `/api/v1/documents/${documentId}/review`, {
        token: account.accessToken,
      }),
      harness.api.json('PATCH', `/api/v1/review/${review.reviewId}/fields`, {
        token: account.accessToken,
        body: { changes: [{ fieldPath: 'total.amount', value: 1 }] },
      }),
      harness.api.json('POST', `/api/v1/review/${review.reviewId}/approve`, {
        token: account.accessToken,
        body: {},
      }),
      harness.api.json('POST', `/api/v1/review/${review.reviewId}/reject`, {
        token: account.accessToken,
        body: { reason: 'old' },
      }),
    ]);
    expect(requests.map((response) => response.statusCode)).toEqual([409, 409, 409, 409]);
    const bulk = await harness.api.json('POST', '/api/v1/review/bulk-approve', {
      token: account.accessToken,
      body: { documentIds: [documentId] },
    });
    expect(bulk.statusCode).toBe(200);
    expect(
      bulk.json<{ approved: string[]; skipped: Array<{ documentId: string }> }>(),
    ).toMatchObject({ approved: [], skipped: [{ documentId }] });
    await harness.services.worker.drain();
    const stale = await harness.api.json('POST', `/api/v1/review/${review.reviewId}/reject`, {
      token: account.accessToken,
      body: { reason: 'old' },
    });
    expect(stale.statusCode).toBe(409);
    const newReview = await openReview(harness, account, documentId);
    expect(newReview.reviewId).not.toBe(review.reviewId);
  });

  it('keeps old reviews superseded if reprocessing fails before publishing a new extraction', async () => {
    const account = await registerAccount(harness);
    const upload = await harness.api.upload(account.accessToken);
    const documentId = upload.json<{ id: string }>().id;
    await harness.services.worker.drain();
    const review = await openReview(harness, account, documentId);
    const reprocess = await harness.api.json('POST', `/api/v1/documents/${documentId}/reprocess`, {
      token: account.accessToken,
    });
    const jobId = reprocess.json<{ jobId: string }>().jobId;
    await harness.db.execute('UPDATE jobs SET max_attempts = 1 WHERE id = ?', [jobId]);
    const ocr = jest
      .spyOn(harness.ocr, 'ocr')
      .mockRejectedValueOnce(new Error('synthetic failure'));
    try {
      await harness.services.worker.drain();
    } finally {
      ocr.mockRestore();
    }
    expect((await new JobsRepository(harness.db).findById(jobId))?.status).toBe('dead');
    expect(
      await harness.db.query('SELECT id FROM extractions WHERE document_id = ?', [documentId]),
    ).toHaveLength(1);
    const rejection = await harness.api.json('POST', `/api/v1/review/${review.reviewId}/reject`, {
      token: account.accessToken,
      body: { reason: 'old' },
    });
    expect(rejection.statusCode).toBe(409);
    expect(
      await harness.db.one('SELECT status FROM reviews WHERE id = ?', [review.reviewId]),
    ).toEqual({ status: 'superseded' });
  });

  it('rolls back review supersession if reprocess auditing fails', async () => {
    const account = await registerAccount(harness);
    const upload = await harness.api.upload(account.accessToken);
    const documentId = upload.json<{ id: string }>().id;
    await harness.services.worker.drain();
    const review = await openReview(harness, account, documentId);
    const fail = jest
      .spyOn(AuditRepository.prototype, 'record')
      .mockRejectedValueOnce(new Error('audit unavailable'));
    try {
      const response = await harness.api.json('POST', `/api/v1/documents/${documentId}/reprocess`, {
        token: account.accessToken,
      });
      expect(response.statusCode).toBe(500);
    } finally {
      fail.mockRestore();
    }
    expect(
      await harness.db.one('SELECT status FROM reviews WHERE id = ?', [review.reviewId]),
    ).toEqual({ status: 'in_progress' });
    const rejection = await harness.api.json('POST', `/api/v1/review/${review.reviewId}/reject`, {
      token: account.accessToken,
      body: { reason: 'still current' },
    });
    expect(rejection.statusCode).toBe(200);
  });

  it('serializes a reprocess request against an old review decision', async () => {
    const account = await registerAccount(harness);
    const upload = await harness.api.upload(account.accessToken);
    const documentId = upload.json<{ id: string }>().id;
    await harness.services.worker.drain();
    const review = await openReview(harness, account, documentId);
    const [reprocess, reject] = await Promise.all([
      harness.api.json('POST', `/api/v1/documents/${documentId}/reprocess`, {
        token: account.accessToken,
      }),
      harness.api.json('POST', `/api/v1/review/${review.reviewId}/reject`, {
        token: account.accessToken,
        body: { reason: 'race' },
      }),
    ]);
    expect(reprocess.statusCode).toBe(202);
    expect([200, 409]).toContain(reject.statusCode);
    expect(await harness.db.one('SELECT status FROM documents WHERE id = ?', [documentId])).toEqual(
      { status: 'queued' },
    );
    const stored = await harness.db.one<{ status: string }>(
      'SELECT status FROM reviews WHERE id = ?',
      [review.reviewId],
    );
    expect(stored?.status).toBe(reject.statusCode === 200 ? 'rejected' : 'superseded');
    await harness.services.worker.drain();
    expect(
      await harness.db.query('SELECT id FROM extractions WHERE document_id = ?', [documentId]),
    ).toHaveLength(2);
  });

  it('serializes simultaneous review decisions so only one is applied', async () => {
    const account = await registerAccount(harness);
    const upload = await harness.api.upload(account.accessToken);
    const documentId = upload.json<{ id: string }>().id;
    await harness.services.worker.drain();
    const review = await openReview(harness, account, documentId);
    const decisions = await Promise.all([
      harness.api.json('POST', `/api/v1/review/${review.reviewId}/reject`, {
        token: account.accessToken,
        body: { reason: 'first' },
      }),
      harness.api.json('POST', `/api/v1/review/${review.reviewId}/reject`, {
        token: account.accessToken,
        body: { reason: 'second' },
      }),
    ]);
    expect(decisions.map((response) => response.statusCode).sort()).toEqual([200, 409]);
    const audits = await harness.db.query(
      'SELECT id FROM audit_logs WHERE target_id = ? AND action = ?',
      [documentId, 'document.rejected'],
    );
    expect(audits).toHaveLength(1);
  });

  it('rolls back corrections and their audit when a correction write fails', async () => {
    const account = await registerAccount(harness);
    const upload = await harness.api.upload(account.accessToken);
    const documentId = upload.json<{ id: string }>().id;
    await harness.services.worker.drain();
    const review = await openReview(harness, account, documentId);
    const before = await harness.db.one('SELECT extraction_id FROM reviews WHERE id = ?', [
      review.reviewId,
    ]);
    // Fail after the review change, document type and audit writes have been attempted.
    const fail = jest
      .spyOn(ExtractionsRepository.prototype, 'create')
      .mockRejectedValueOnce(new Error('extraction unavailable'));
    try {
      const response = await harness.api.json('PATCH', `/api/v1/review/${review.reviewId}/fields`, {
        token: account.accessToken,
        body: {
          changes: [{ fieldPath: 'total.amount', value: 'changed' }],
          documentType: review.documentType,
        },
      });
      expect(response.statusCode).toBe(500);
    } finally {
      fail.mockRestore();
    }
    expect(
      await harness.db.one('SELECT extraction_id FROM reviews WHERE id = ?', [review.reviewId]),
    ).toEqual(before);
    expect(
      await harness.db.query('SELECT id FROM review_changes WHERE review_id = ?', [
        review.reviewId,
      ]),
    ).toHaveLength(0);
    expect(
      await harness.db.query('SELECT id FROM audit_logs WHERE target_id = ? AND action = ?', [
        documentId,
        'document.field_corrected',
      ]),
    ).toHaveLength(0);
    expect(
      await harness.db.query('SELECT id FROM extractions WHERE document_id = ?', [documentId]),
    ).toHaveLength(1);
  });

  it('rolls back a review decision if auditing fails', async () => {
    const account = await registerAccount(harness);
    const upload = await harness.api.upload(account.accessToken);
    const documentId = upload.json<{ id: string }>().id;
    await harness.services.worker.drain();
    const review = await openReview(harness, account, documentId);
    const before = await harness.db.one('SELECT status FROM documents WHERE id = ?', [documentId]);
    const fail = jest
      .spyOn(AuditRepository.prototype, 'record')
      .mockRejectedValueOnce(new Error('audit unavailable'));
    try {
      const response = await harness.api.json('POST', `/api/v1/review/${review.reviewId}/reject`, {
        token: account.accessToken,
        body: { reason: 'test' },
      });
      expect(response.statusCode).toBe(500);
    } finally {
      fail.mockRestore();
    }
    expect(
      await harness.db.one('SELECT status FROM reviews WHERE id = ?', [review.reviewId]),
    ).toEqual({ status: 'in_progress' });
    expect(await harness.db.one('SELECT status FROM documents WHERE id = ?', [documentId])).toEqual(
      before,
    );
  });

  it('rejects an old review decision while new OCR is running and publishes the new extraction', async () => {
    const account = await registerAccount(harness);
    const upload = await harness.api.upload(account.accessToken);
    const documentId = upload.json<{ id: string }>().id;
    await harness.services.worker.drain();
    const oldReview = await openReview(harness, account, documentId);
    const before = await harness.db.query<{ id: string }>(
      'SELECT id FROM extractions WHERE document_id = ?',
      [documentId],
    );
    expect(before).toHaveLength(1);
    const reprocess = await harness.api.json('POST', `/api/v1/documents/${documentId}/reprocess`, {
      token: account.accessToken,
    });
    expect(reprocess.statusCode).toBe(202);
    const jobId = reprocess.json<{ jobId: string }>().jobId;

    let entered!: () => void;
    let resume!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const paused = new Promise<void>((resolve) => {
      resume = resolve;
    });
    const original = harness.ocr.ocr.bind(harness.ocr);
    const ocr = jest.spyOn(harness.ocr, 'ocr').mockImplementationOnce(async () => {
      entered();
      await paused;
      return original();
    });
    let work: Promise<number> | undefined;
    try {
      work = harness.services.worker.drain();
      await started;
      const rejected = await harness.api.json(
        'POST',
        `/api/v1/review/${oldReview.reviewId}/reject`,
        {
          token: account.accessToken,
          body: { reason: 'Old result rejected' },
        },
      );
      expect(rejected.statusCode).toBe(409);
      resume();
      await work;
      expect((await new JobsRepository(harness.db).findById(jobId))?.status).toBe('succeeded');
      expect(
        await harness.db.query('SELECT id FROM extractions WHERE document_id = ?', [documentId]),
      ).toHaveLength(2);
      expect(
        (
          await harness.db.one<{ status: string }>('SELECT status FROM documents WHERE id = ?', [
            documentId,
          ])
        )?.status,
      ).not.toBe('failed');
    } finally {
      resume();
      if (work) await work.catch(() => undefined);
      ocr.mockRestore();
    }
  });
});
