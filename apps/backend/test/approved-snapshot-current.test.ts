import { ReviewsRepository } from '../src/repositories/review-repo';
import { JobsRepository } from '../src/repositories/system-repo';
import { approveDocument, createHarness, registerAccount, type Harness } from './helpers';

describe('current approved snapshots', () => {
  let harness: Harness;
  beforeEach(async () => {
    harness = await createHarness();
  });
  afterEach(async () => {
    await harness.close();
  });

  it('does not return historical approvals for active jobs, newer extractions, or deleted documents', async () => {
    const account = await registerAccount(harness);
    const upload = await harness.api.upload(account.accessToken);
    const documentId = upload.json<{ id: string }>().id;
    await harness.services.worker.drain();
    await approveDocument(harness, account, documentId);
    const reviews = new ReviewsRepository(harness.db);
    expect(await reviews.findApprovedUdm(documentId)).not.toBeNull();

    const jobs = new JobsRepository(harness.db);
    const duplicate = await jobs.enqueue({
      organisationId: account.organisationId,
      type: 'extract_document',
      documentId,
    });
    expect(await reviews.findApprovedUdm(documentId)).toBeNull();
    await harness.db.execute('DELETE FROM jobs WHERE id = ?', [duplicate.id]);
    expect(await reviews.findApprovedUdm(documentId)).not.toBeNull();

    const reprocess = await harness.api.json('POST', `/api/v1/documents/${documentId}/reprocess`, {
      token: account.accessToken,
    });
    expect(reprocess.statusCode).toBe(202);
    expect(await reviews.findApprovedUdm(documentId)).toBeNull();
    await harness.services.worker.drain();
    // Deliberately corrupt the status to demonstrate that status alone is insufficient.
    await harness.db.execute("UPDATE documents SET status = 'approved' WHERE id = ?", [documentId]);
    expect(await reviews.findApprovedUdm(documentId)).toBeNull();
    await harness.db.execute("UPDATE documents SET status = 'needs_review' WHERE id = ?", [
      documentId,
    ]);
    await approveDocument(harness, account, documentId);
    expect(await reviews.findApprovedUdm(documentId)).not.toBeNull();
    await harness.api.json('DELETE', `/api/v1/documents/${documentId}`, {
      token: account.accessToken,
    });
    expect(await reviews.findApprovedUdm(documentId)).toBeNull();
  });
});
