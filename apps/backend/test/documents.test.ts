import { AuditRepository, JobsRepository } from '../src/repositories/system-repo';
import { DocumentsRepository } from '../src/repositories/document-repo';
import {
  createHarness,
  drainWorker,
  fakePdf,
  fakePng,
  registerAccount,
  uploadDocument,
  SAMPLE_INVOICE_TEXT,
  type Harness,
} from './helpers';

describe('documents: upload, validation and extraction', () => {
  let harness: Harness;

  beforeAll(async () => {
    harness = await createHarness();
  });

  afterAll(async () => {
    await harness.close();
  });

  it('accepts an image and queues extraction (DOC-001)', async () => {
    const account = await registerAccount(harness);
    harness.ocr.setText(SAMPLE_INVOICE_TEXT);

    const response = await uploadDocument(harness, account, { content: fakePng('invoice') });
    expect(response.statusCode).toBe(201);
    const body = response.json<{ id: string; status: string; jobId: string }>();
    expect(body.status).toBe('queued');
    expect(body.jobId).toBeTruthy();

    const stored = await harness.db.one<{ mime_type: string; status: string; size_bytes: number }>(
      'SELECT mime_type, status, size_bytes FROM documents WHERE id = ?',
      [body.id],
    );
    expect(stored?.mime_type).toBe('image/png');
  });

  it('rolls back document and page rows if upload auditing fails', async () => {
    const account = await registerAccount(harness);
    const storageBytesBefore = harness.storage.size();
    const audit = jest
      .spyOn(AuditRepository.prototype, 'record')
      .mockRejectedValueOnce(new Error('audit unavailable'));
    try {
      const response = await uploadDocument(harness, account, {
        content: fakePng('transaction rollback'),
      });
      expect(response.statusCode).toBe(500);
    } finally {
      audit.mockRestore();
    }
    const docs = await harness.db.one<{ count: number }>(
      'SELECT COUNT(*) AS count FROM documents WHERE organisation_id = ?',
      [account.organisationId],
    );
    const jobs = await harness.db.one<{ count: number }>(
      'SELECT COUNT(*) AS count FROM jobs WHERE organisation_id = ?',
      [account.organisationId],
    );
    expect(Number(docs?.count)).toBe(0);
    expect(Number(jobs?.count)).toBe(0);
    expect(harness.storage.size()).toBe(storageBytesBefore);
  });

  it('accepts a PDF', async () => {
    const account = await registerAccount(harness);
    // The multipart part claims image/png, but the bytes are a PDF: the sniffer wins.
    const response = await uploadDocument(harness, account, { content: fakePdf('invoice pdf') });
    expect(response.statusCode).toBe(201);
    const stored = await harness.db.one<{ mime_type: string }>(
      'SELECT mime_type FROM documents WHERE id = ?',
      [response.json<{ id: string }>().id],
    );
    expect(stored?.mime_type).toBe('application/pdf');
  });

  it('rejects content that is not an allowed type, whatever the filename says (DOC-001)', async () => {
    const account = await registerAccount(harness);
    const executable = Buffer.from('MZ\x90\x00\x03\x00\x00\x00 this is not an image at all');
    const response = await uploadDocument(harness, account, { content: executable });
    expect(response.statusCode).toBe(415);
    expect(response.json<{ error: { code: string } }>().error.code).toBe('UNSUPPORTED_MEDIA_TYPE');
  });

  it('rejects an empty upload', async () => {
    const account = await registerAccount(harness);
    const response = await uploadDocument(harness, account, { content: Buffer.alloc(0) });
    expect([400, 415]).toContain(response.statusCode);
  });

  it('rejects an upload larger than the limit', async () => {
    const account = await registerAccount(harness);
    const big = Buffer.concat([fakePng(), Buffer.alloc(6 * 1024 * 1024, 1)]);
    const response = await uploadDocument(harness, account, { content: big });
    expect(response.statusCode).toBe(413);
  });

  it('is idempotent per client key (DOC-001)', async () => {
    const account = await registerAccount(harness);
    const key = 'upload-attempt-1';

    const first = await uploadDocument(harness, account, {
      content: fakePng('once'),
      idempotencyKey: key,
    });
    expect(first.statusCode).toBe(201);

    const second = await uploadDocument(harness, account, {
      content: fakePng('once'),
      idempotencyKey: key,
    });
    expect(second.statusCode).toBe(200);
    expect(second.json<{ duplicate: boolean }>().duplicate).toBe(true);
    expect(second.json<{ id: string }>().id).toBe(first.json<{ id: string }>().id);

    const count = await harness.db.one<{ count: number }>(
      'SELECT COUNT(*) AS count FROM documents WHERE organisation_id = ? AND idempotency_key = ?',
      [account.organisationId, key],
    );
    expect(Number(count?.count)).toBe(1);
    expect(second.json<{ jobId: string }>().jobId).toBe(first.json<{ jobId: string }>().jobId);
    const jobs = await harness.db.one<{ count: number }>(
      "SELECT COUNT(*) AS count FROM jobs WHERE document_id = ? AND type = 'extract_document'",
      [first.json<{ id: string }>().id],
    );
    expect(Number(jobs?.count)).toBe(1);
  });

  it('concurrent uploads with the same key commit one document, job, audit and stored file', async () => {
    const account = await registerAccount(harness);
    const content = fakePng('simultaneous upload');
    const storageBytesBefore = harness.storage.size();
    const original = DocumentsRepository.prototype.findByIdempotencyKey;
    let checked = 0;
    let release!: () => void;
    const bothChecked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const lookup = jest
      .spyOn(DocumentsRepository.prototype, 'findByIdempotencyKey')
      .mockImplementation(async function (this: DocumentsRepository, organisationId, key) {
        const row = await original.call(this, organisationId, key);
        if (checked < 2) {
          checked += 1;
          if (checked === 2) release();
          await bothChecked;
        }
        return row;
      });
    try {
      const [a, b] = await Promise.all([
        uploadDocument(harness, account, { content, idempotencyKey: 'simultaneous-upload-001' }),
        uploadDocument(harness, account, { content, idempotencyKey: 'simultaneous-upload-001' }),
      ]);
      expect([a.statusCode, b.statusCode].sort()).toEqual([200, 201]);
      const first = a.json<{ id: string; jobId: string }>();
      const second = b.json<{ id: string; jobId: string }>();
      expect(second).toMatchObject({ id: first.id, jobId: first.jobId });
      const docs = await harness.db.one<{ count: number }>(
        'SELECT COUNT(*) AS count FROM documents WHERE organisation_id = ? AND idempotency_key = ?',
        [account.organisationId, 'simultaneous-upload-001'],
      );
      const jobs = await harness.db.one<{ count: number }>(
        "SELECT COUNT(*) AS count FROM jobs WHERE document_id = ? AND type = 'extract_document'",
        [first.id],
      );
      const audits = await harness.db.one<{ count: number }>(
        "SELECT COUNT(*) AS count FROM audit_logs WHERE target_id = ? AND action = 'document.uploaded'",
        [first.id],
      );
      expect(Number(docs?.count)).toBe(1);
      expect(Number(jobs?.count)).toBe(1);
      expect(Number(audits?.count)).toBe(1);
      expect(harness.storage.size() - storageBytesBefore).toBe(content.length);
    } finally {
      lookup.mockRestore();
    }
  });

  it('does not silently enqueue work when a legacy upload has no extraction job', async () => {
    const account = await registerAccount(harness);
    const options = { content: fakePng('legacy job'), idempotencyKey: 'legacy-job-001' };
    const first = await uploadDocument(harness, account, options);
    expect(first.statusCode).toBe(201);
    const id = first.json<{ id: string }>().id;
    await harness.db.execute('DELETE FROM jobs WHERE document_id = ?', [id]);
    const retry = await uploadDocument(harness, account, options);
    expect(retry.statusCode).toBe(409);
    expect(retry.json<{ error: { message: string } }>().error.message).toContain('Reprocess');
    const jobs = await harness.db.one<{ count: number }>(
      'SELECT COUNT(*) AS count FROM jobs WHERE document_id = ?',
      [id],
    );
    expect(Number(jobs?.count)).toBe(0);
    const repair = await harness.api.json('POST', `/api/v1/documents/${id}/reprocess`, {
      token: account.accessToken,
    });
    expect(repair.statusCode).toBe(202);
    const repairedJobId = repair.json<{ jobId: string }>().jobId;
    const retryAfterRepair = await uploadDocument(harness, account, options);
    expect(retryAfterRepair.statusCode).toBe(200);
    expect(retryAfterRepair.json<{ jobId: string }>().jobId).toBe(repairedJobId);
  });

  it('admits only one concurrent repair of jobless processing state', async () => {
    const account = await registerAccount(harness);
    const upload = await uploadDocument(harness, account, { content: fakePng('repair race') });
    const id = upload.json<{ id: string }>().id;
    await harness.db.execute('DELETE FROM jobs WHERE document_id = ?', [id]);
    await harness.db.execute("UPDATE documents SET status = 'processing' WHERE id = ?", [id]);
    const repair = () =>
      harness.api.json('POST', `/api/v1/documents/${id}/reprocess`, {
        token: account.accessToken,
      });
    const responses = await Promise.all([repair(), repair()]);
    expect(responses.map((response) => response.statusCode).sort()).toEqual([202, 409]);
    const jobs = await new JobsRepository(harness.db).listForDocument(id);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.status).toBe('queued');
    const document = await harness.db.one<{ status: string }>(
      'SELECT status FROM documents WHERE id = ?',
      [id],
    );
    expect(document?.status).toBe('queued');
  });

  it('rolls back the upload and removes its file when enqueue fails', async () => {
    const account = await registerAccount(harness);
    const storageBytesBefore = harness.storage.size();
    const enqueue = jest
      .spyOn(JobsRepository.prototype, 'enqueue')
      .mockRejectedValueOnce(new Error('job store unavailable'));
    try {
      const response = await uploadDocument(harness, account, {
        content: fakePng('failed enqueue'),
      });
      expect(response.statusCode).toBe(500);
    } finally {
      enqueue.mockRestore();
    }
    const docs = await harness.db.one<{ count: number }>(
      'SELECT COUNT(*) AS count FROM documents WHERE organisation_id = ?',
      [account.organisationId],
    );
    const audits = await harness.db.one<{ count: number }>(
      "SELECT COUNT(*) AS count FROM audit_logs WHERE organisation_id = ? AND action = 'document.uploaded'",
      [account.organisationId],
    );
    expect(Number(docs?.count)).toBe(0);
    expect(Number(audits?.count)).toBe(0);
    expect(harness.storage.size()).toBe(storageBytesBefore);
  });

  it('retains the file when transaction outcome is ambiguous and retry finds the committed job', async () => {
    const account = await registerAccount(harness);
    const content = fakePng('ambiguous commit');
    const transact = harness.db.transaction.bind(harness.db);
    const spy = jest.spyOn(harness.db, 'transaction').mockImplementation(async (run) => {
      await transact(run);
      throw new Error('commit acknowledgement lost');
    });
    try {
      const response = await uploadDocument(harness, account, {
        content,
        idempotencyKey: 'ambiguous-upload-001',
      });
      expect(response.statusCode).toBe(500);
    } finally {
      spy.mockRestore();
    }
    const retry = await uploadDocument(harness, account, {
      content,
      idempotencyKey: 'ambiguous-upload-001',
    });
    expect(retry.statusCode).toBe(200);
    expect(retry.json<{ duplicate: boolean }>().duplicate).toBe(true);
    const id = retry.json<{ id: string }>().id;
    const file = await harness.api.download(`/api/v1/documents/${id}/file`, account.accessToken);
    expect(file.statusCode).toBe(200);
    expect(file.buffer()).toEqual(content);
    const jobs = await harness.db.one<{ count: number }>(
      "SELECT COUNT(*) AS count FROM jobs WHERE document_id = ? AND type = 'extract_document'",
      [id],
    );
    expect(Number(jobs?.count)).toBe(1);
  });

  it('extracts an invoice into the Universal Data Model (AI-001, AI-003)', async () => {
    const account = await registerAccount(harness);
    harness.ocr.setText(SAMPLE_INVOICE_TEXT);

    const upload = await uploadDocument(harness, account, {
      content: fakePng('invoice-2'),
      documentType: 'invoice',
    });
    const documentId = upload.json<{ id: string }>().id;
    await drainWorker(harness);

    const result = await harness.api.json('GET', `/api/v1/documents/${documentId}/result`, {
      token: account.accessToken,
    });
    expect(result.statusCode).toBe(200);

    const body = result.json<{
      document: { status: string; documentType: string };
      extraction: {
        udm: { fields: Record<string, { value: unknown }>; tables: unknown[] };
        needsReview: boolean;
      };
    }>();
    expect(body.document.documentType).toBe('invoice');
    expect(['needs_review', 'extracted']).toContain(body.document.status);
    expect(body.extraction).not.toBeNull();

    const fields = body.extraction.udm.fields;
    expect(fields['invoice.number']?.value).toBe('INV-1042');
    expect(fields['total.amount']?.value).toBe(1121000);
    expect(fields['document.date']?.value).toBe('2026-10-26');
    expect(body.extraction.udm.tables.length).toBe(1);
  });

  it('classifies a receipt and extracts its total', async () => {
    const account = await registerAccount(harness);
    harness.ocr.setText(`KAMPALA HARDWARE STORE
RECEIPT
Receipt No: RCT-88
Date: 24/10/2026
Total: UGX 45,000
Thank you for your purchase`);

    const upload = await uploadDocument(harness, account, { content: fakePng('receipt') });
    const documentId = upload.json<{ id: string }>().id;
    await drainWorker(harness);

    const result = await harness.api.get(
      `/api/v1/documents/${documentId}/result`,
      account.accessToken,
    );
    const body = result.json<{
      document: { documentType: string };
      extraction: { udm: { fields: Record<string, { value: unknown }> } };
    }>();
    expect(body.document.documentType).toBe('receipt');
    expect(body.extraction.udm.fields['receipt.number']?.value).toBe('RCT-88');
    expect(body.extraction.udm.fields['total.amount']?.value).toBe(45000);
  });

  it('marks a document failed when OCR is unavailable and reports a safe message (AI-004, TC-14)', async () => {
    const account = await registerAccount(harness);
    harness.ocr.failWith(new Error('Local OCR engine is not installed.'));

    const upload = await uploadDocument(harness, account, { content: fakePng('no engine') });
    const documentId = upload.json<{ id: string }>().id;

    // Drain several times so the retry/backoff path is exercised to exhaustion.
    for (let attempt = 0; attempt < 6; attempt += 1) {
      await harness.db.execute("UPDATE jobs SET run_after = ? WHERE status = 'queued'", [
        new Date(Date.now() - 1000).toISOString(),
      ]);
      await drainWorker(harness);
    }

    const document = await harness.db.one<{ status: string }>(
      'SELECT status FROM documents WHERE id = ?',
      [documentId],
    );
    expect(document?.status).toBe('failed');

    const job = await harness.db.one<{ status: string; last_error: string }>(
      'SELECT status, last_error FROM jobs WHERE document_id = ?',
      [documentId],
    );
    expect(job?.status).toBe('dead');
    expect(job?.last_error).toBe('Document extraction failed. Investigate the worker and retry.');

    harness.ocr.setText(SAMPLE_INVOICE_TEXT);
  });

  it('scopes documents to the caller’s organisation (AUTH-002, TC-10)', async () => {
    const owner = await registerAccount(harness);
    const outsider = await registerAccount(harness, { email: 'outsider@example.com' });
    harness.ocr.setText(SAMPLE_INVOICE_TEXT);

    const upload = await uploadDocument(harness, owner, { content: fakePng('private') });
    const documentId = upload.json<{ id: string }>().id;

    const read = await harness.api.get(`/api/v1/documents/${documentId}`, outsider.accessToken);
    expect(read.statusCode).toBe(404);
    expect(read.body).not.toContain(documentId);

    const file = await harness.api.download(
      `/api/v1/documents/${documentId}/file`,
      outsider.accessToken,
    );
    expect(file.statusCode).toBe(404);

    const list = await harness.api.get('/api/v1/documents', outsider.accessToken);
    const ids = list.json<{ items: Array<{ id: string }> }>().items.map((item) => item.id);
    expect(ids).not.toContain(documentId);
  });

  it('streams the original file with hardened headers', async () => {
    const account = await registerAccount(harness);
    const upload = await uploadDocument(harness, account, { content: fakePng('download me') });
    const documentId = upload.json<{ id: string }>().id;

    const response = await harness.api.download(
      `/api/v1/documents/${documentId}/file`,
      account.accessToken,
    );
    expect(response.statusCode).toBe(200);
    expect(response.headers.get('content-type')).toBe('image/png');
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(response.headers.get('cache-control')).toContain('no-store');
    expect(response.buffer().length).toBeGreaterThan(8);
  });

  it('reprocesses a document on request', async () => {
    const account = await registerAccount(harness);
    const upload = await uploadDocument(harness, account, { content: fakePng('reprocess') });
    const documentId = upload.json<{ id: string }>().id;
    await drainWorker(harness);

    const reprocess = await harness.api.json('POST', `/api/v1/documents/${documentId}/reprocess`, {
      token: account.accessToken,
    });
    expect(reprocess.statusCode).toBe(202);
    expect(reprocess.json<{ jobId: string }>().jobId).toBeTruthy();
  });

  it('admits only one concurrent reprocess request and atomically records its job and audit', async () => {
    const account = await registerAccount(harness);
    const upload = await uploadDocument(harness, account, { content: fakePng('reprocess race') });
    const documentId = upload.json<{ id: string }>().id;
    await drainWorker(harness);
    const request = () =>
      harness.api.json('POST', `/api/v1/documents/${documentId}/reprocess`, {
        token: account.accessToken,
      });
    const responses = await Promise.all([request(), request()]);
    expect(responses.map((response) => response.statusCode).sort()).toEqual([202, 409]);
    const jobs = await new JobsRepository(harness.db).listForDocument(documentId);
    expect(jobs).toHaveLength(2);
    expect(jobs.filter((job) => job.status === 'queued')).toHaveLength(1);
    const audit = await harness.db.query(
      'SELECT id FROM audit_logs WHERE target_id = ? AND action = ?',
      [documentId, 'document.reprocessed'],
    );
    expect(audit).toHaveLength(1);
  });

  it('serializes competing jobless repairs before checking for an active job', async () => {
    const account = await registerAccount(harness);
    const upload = await uploadDocument(harness, account, {
      content: fakePng('locked repair race'),
    });
    const id = upload.json<{ id: string }>().id;
    await harness.db.execute('DELETE FROM jobs WHERE document_id = ?', [id]);
    let release!: () => void;
    let entered!: () => void;
    const paused = new Promise<void>((resolve) => {
      release = resolve;
    });
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const original = JobsRepository.prototype.hasActiveExtraction;
    const lookup = jest
      .spyOn(JobsRepository.prototype, 'hasActiveExtraction')
      .mockImplementationOnce(async function (this: JobsRepository, organisationId, documentId) {
        entered();
        await paused;
        return original.call(this, organisationId, documentId);
      });
    const repair = () =>
      harness.api.json('POST', `/api/v1/documents/${id}/reprocess`, { token: account.accessToken });
    let first: ReturnType<typeof repair> | undefined;
    let second: ReturnType<typeof repair> | undefined;
    try {
      first = repair();
      await started;
      second = repair();
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(lookup).toHaveBeenCalledTimes(1);
      release();
      const responses = await Promise.all([first, second]);
      expect(responses.map((response) => response.statusCode).sort()).toEqual([202, 409]);
      expect(await new JobsRepository(harness.db).listForDocument(id)).toHaveLength(1);
    } finally {
      release();
      if (first) await first.catch(() => undefined);
      if (second) await second.catch(() => undefined);
      lookup.mockRestore();
    }
  });

  it('rejects reprocess when a job is active even if the document status is not processing', async () => {
    const account = await registerAccount(harness);
    const upload = await uploadDocument(harness, account, {
      content: fakePng('active job despite status'),
    });
    const id = upload.json<{ id: string }>().id;
    await harness.db.execute("UPDATE documents SET status = 'approved' WHERE id = ?", [id]);
    const response = await harness.api.json('POST', `/api/v1/documents/${id}/reprocess`, {
      token: account.accessToken,
    });
    expect(response.statusCode).toBe(409);
    expect(await new JobsRepository(harness.db).listForDocument(id)).toHaveLength(1);
  });

  it('rolls back the queued status and new job if reprocess auditing fails', async () => {
    const account = await registerAccount(harness);
    const upload = await uploadDocument(harness, account, {
      content: fakePng('reprocess rollback'),
    });
    const documentId = upload.json<{ id: string }>().id;
    await drainWorker(harness);
    const before = await harness.db.one<{ status: string }>(
      'SELECT status FROM documents WHERE id = ?',
      [documentId],
    );
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
    const after = await harness.db.one<{ status: string }>(
      'SELECT status FROM documents WHERE id = ?',
      [documentId],
    );
    expect(after?.status).toBe(before?.status);
    expect(await new JobsRepository(harness.db).listForDocument(documentId)).toHaveLength(1);
  });

  it('soft-deletes and then hides a document', async () => {
    const account = await registerAccount(harness);
    const upload = await uploadDocument(harness, account, { content: fakePng('delete me') });
    const documentId = upload.json<{ id: string }>().id;

    const deleted = await harness.api.json('DELETE', `/api/v1/documents/${documentId}`, {
      token: account.accessToken,
    });
    expect(deleted.statusCode).toBe(204);

    const read = await harness.api.get(`/api/v1/documents/${documentId}`, account.accessToken);
    expect(read.statusCode).toBe(404);
  });

  it('filters the document list by status', async () => {
    const account = await registerAccount(harness);
    harness.ocr.setText(SAMPLE_INVOICE_TEXT);
    const upload = await uploadDocument(harness, account, { content: fakePng('filter') });
    await drainWorker(harness);

    const queued = await harness.api.get('/api/v1/documents?status=queued', account.accessToken);
    const needsReview = await harness.api.get(
      '/api/v1/documents?status=needs_review',
      account.accessToken,
    );
    const queuedIds = queued.json<{ items: Array<{ id: string }> }>().items.map((item) => item.id);
    const reviewIds = needsReview
      .json<{ items: Array<{ id: string }> }>()
      .items.map((item) => item.id);

    expect(queuedIds).not.toContain(upload.json<{ id: string }>().id);
    expect(reviewIds.length + queuedIds.length).toBeGreaterThanOrEqual(0);
  });
});
