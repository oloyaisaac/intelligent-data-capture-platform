import { DocumentsRepository } from '../src/repositories/document-repo';
import { createHarness, registerAccount } from './helpers';

/** Characterizes ARC-027; this is not a safe workflow-approval protocol. */
it('can overwrite a completed workflow run as failed after concurrent approvals', async () => {
  const harness = await createHarness();
  let releaseFirst!: () => void;
  let releaseSecond!: () => void;
  let firstEntered!: () => void;
  let bothEntered!: () => void;
  const firstGate = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  const secondGate = new Promise<void>((resolve) => {
    releaseSecond = resolve;
  });
  const firstReady = new Promise<void>((resolve) => {
    firstEntered = resolve;
  });
  const both = new Promise<void>((resolve) => {
    bothEntered = resolve;
  });
  try {
    const account = await registerAccount(harness);
    const upload = await harness.api.upload(account.accessToken);
    const documentId = upload.json<{ id: string }>().id;
    const created = await harness.api.json('POST', '/api/v1/workflows', {
      token: account.accessToken,
      body: {
        name: 'Delete after approval',
        trigger: 'document.extracted',
        conditions: [],
        actions: [{ type: 'delete_document', config: {} }],
      },
    });
    expect(created.statusCode).toBe(201);
    const evaluation = await harness.api.json('POST', '/api/v1/workflows/evaluate', {
      token: account.accessToken,
      body: { trigger: 'document.extracted', documentId },
    });
    const run = evaluation.json<{ runs: Array<{ id: string; status: string }> }>().runs[0]!;
    expect(run.status).toBe('awaiting_approval');
    const original = DocumentsRepository.prototype.softDelete;
    let calls = 0;
    const spy = jest
      .spyOn(DocumentsRepository.prototype, 'softDelete')
      .mockImplementation(async function (this: DocumentsRepository, org, id) {
        calls += 1;
        if (calls === 1) {
          firstEntered();
          await firstGate;
        } else {
          bothEntered();
          await secondGate;
        }
        return original.call(this, org, id);
      });
    const approve = () =>
      harness.api.json('POST', `/api/v1/workflows/runs/${run.id}/approve`, {
        token: account.accessToken,
      });
    const first = approve();
    await firstReady;
    const second = approve();
    try {
      await both;
      releaseFirst();
      expect((await first).statusCode).toBe(200);
      releaseSecond();
      expect((await second).statusCode).toBe(409);
      expect(
        await harness.db.one('SELECT status FROM workflow_runs WHERE id = ?', [run.id]),
      ).toEqual({ status: 'failed' });
      expect(
        await harness.db.query('SELECT id FROM audit_logs WHERE action = ? AND target_id = ?', [
          'workflow.run_approved',
          created.json<{ id: string }>().id,
        ]),
      ).toHaveLength(1);
      const document = await harness.db.one<{ deleted_at: string | null }>(
        'SELECT deleted_at FROM documents WHERE id = ?',
        [documentId],
      );
      expect(document?.deleted_at).not.toBeNull();
    } finally {
      releaseFirst();
      releaseSecond();
      await Promise.allSettled([first, second]);
      spy.mockRestore();
    }
  } finally {
    await harness.close();
  }
}, 15_000);
