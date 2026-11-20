import { DocumentsRepository } from '../src/repositories/document-repo';
import { AuditRepository } from '../src/repositories/system-repo';
import { createHarness, registerAccount, type Harness, type TestAccount } from './helpers';

async function pendingDelete(harness: Harness, account: TestAccount) {
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
  return { documentId, runId: run.id, workflowId: created.json<{ id: string }>().id };
}

it('serializes competing approvals and commits one deletion with its audits', async () => {
  const harness = await createHarness();
  let release!: () => void;
  let entered!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const ready = new Promise<void>((resolve) => {
    entered = resolve;
  });
  try {
    const account = await registerAccount(harness);
    const { documentId, runId, workflowId } = await pendingDelete(harness, account);
    const original = DocumentsRepository.prototype.softDelete;
    const spy = jest
      .spyOn(DocumentsRepository.prototype, 'softDelete')
      .mockImplementation(async function (this: DocumentsRepository, org, id) {
        entered();
        await gate;
        return original.call(this, org, id);
      });
    const approve = () =>
      harness.api.json('POST', `/api/v1/workflows/runs/${runId}/approve`, {
        token: account.accessToken,
      });
    const first = approve();
    await ready;
    const second = approve();
    try {
      release();
      const responses = await Promise.all([first, second]);
      expect(responses.map((response) => response.statusCode).sort()).toEqual([200, 409]);
      expect(spy).toHaveBeenCalledTimes(1);
      expect(
        await harness.db.one('SELECT status FROM workflow_runs WHERE id = ?', [runId]),
      ).toEqual({ status: 'completed' });
      expect(
        await harness.db.query('SELECT id FROM audit_logs WHERE action = ? AND target_id = ?', [
          'workflow.run_approved',
          workflowId,
        ]),
      ).toHaveLength(1);
      expect(
        await harness.db.query('SELECT id FROM audit_logs WHERE action = ? AND target_id = ?', [
          'document.deleted',
          documentId,
        ]),
      ).toHaveLength(1);
      const document = await harness.db.one<{ deleted_at: string | null }>(
        'SELECT deleted_at FROM documents WHERE id = ?',
        [documentId],
      );
      expect(document?.deleted_at).not.toBeNull();
    } finally {
      release();
      await Promise.allSettled([first, second]);
      spy.mockRestore();
    }
  } finally {
    await harness.close();
  }
}, 15_000);

it.each(['document.deleted', 'workflow.run_approved'])(
  'rolls back the delete and completion when %s auditing fails, then allows retry',
  async (action) => {
    const harness = await createHarness();
    try {
      const account = await registerAccount(harness);
      const { documentId, runId, workflowId } = await pendingDelete(harness, account);
      const original = AuditRepository.prototype.record;
      const failure = jest
        .spyOn(AuditRepository.prototype, 'record')
        .mockImplementation(async function (this: AuditRepository, input) {
          if (input.action === action) throw new Error('secret synthetic audit failure');
          return original.call(this, input);
        });
      try {
        const response = await harness.api.json('POST', `/api/v1/workflows/runs/${runId}/approve`, {
          token: account.accessToken,
        });
        expect(response.statusCode).toBe(500);
        expect(response.body).not.toContain('secret synthetic audit failure');
      } finally {
        failure.mockRestore();
      }
      expect(
        await harness.db.one('SELECT status FROM workflow_runs WHERE id = ?', [runId]),
      ).toEqual({ status: 'awaiting_approval' });
      expect(
        await harness.db.one('SELECT deleted_at FROM documents WHERE id = ?', [documentId]),
      ).toEqual({ deleted_at: null });
      expect(
        await harness.db.query('SELECT id FROM audit_logs WHERE action = ? AND target_id = ?', [
          'document.deleted',
          documentId,
        ]),
      ).toHaveLength(0);
      expect(
        await harness.db.query('SELECT id FROM audit_logs WHERE action = ? AND target_id = ?', [
          'workflow.run_approved',
          workflowId,
        ]),
      ).toHaveLength(0);
      const retry = await harness.api.json('POST', `/api/v1/workflows/runs/${runId}/approve`, {
        token: account.accessToken,
      });
      expect(retry.statusCode).toBe(200);
    } finally {
      await harness.close();
    }
  },
  15_000,
);
