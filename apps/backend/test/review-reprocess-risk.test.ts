import { createHarness, openReview, registerAccount, type Harness } from './helpers';
import { JobsRepository } from '../src/repositories/system-repo';

// Characterization of an OPEN defect, not an acceptable review contract or an R01 passing test.
describe('review/reprocess race risk', () => {
  let harness: Harness;
  beforeEach(async () => {
    harness = await createHarness();
  });
  afterEach(async () => {
    await harness.services.worker.stop();
    await harness.close();
  });

  it('currently permits an old review to reject a document while new OCR is running', async () => {
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
      // Current unsafe behavior: a decision about the old extraction changes the new work's state.
      expect(rejected.statusCode).toBe(200);
      resume();
      await work;
      expect((await new JobsRepository(harness.db).findById(jobId))?.status).toBe('succeeded');
      expect(
        await harness.db.query('SELECT id FROM extractions WHERE document_id = ?', [documentId]),
      ).toHaveLength(1);
      expect(
        await harness.db.one('SELECT status FROM documents WHERE id = ?', [documentId]),
      ).toEqual({ status: 'failed' });
    } finally {
      resume();
      if (work) await work.catch(() => undefined);
      ocr.mockRestore();
    }
  });
});
