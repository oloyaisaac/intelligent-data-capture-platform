import { WorkflowRunsRepository } from '../src/repositories/workflow-repo';
import {
  approveDocument,
  createHarness,
  registerAccount,
  SAMPLE_INVOICE_TEXT,
  type Harness,
  type TestAccount,
} from './helpers';

async function setup(harness: Harness, owner: TestAccount, policy: 'always_ask' | 'auto_approve') {
  harness.ocr.setText(SAMPLE_INVOICE_TEXT);
  const upload = await harness.api.upload(owner.accessToken);
  const documentId = upload.json<{ id: string }>().id;
  await harness.services.worker.drain();
  await approveDocument(harness, owner, documentId);
  const created = await harness.api.json('POST', '/api/v1/workflows', {
    token: owner.accessToken,
    body: {
      name: 'Delete',
      trigger: 'document.approved',
      conditions: [],
      actions: [{ type: 'delete_document' }],
      approvalPolicy: policy,
    },
  });
  expect(created.statusCode).toBe(201);
  return { documentId, workflowId: created.json<{ id: string }>().id };
}

async function change(
  harness: Harness,
  owner: TestAccount,
  workflowId: string,
  operation: 'disable' | 'remove',
) {
  return operation === 'disable'
    ? harness.api.json('PATCH', `/api/v1/workflows/${workflowId}`, {
        token: owner.accessToken,
        body: { enabled: false },
      })
    : harness.api.json('DELETE', `/api/v1/workflows/${workflowId}`, { token: owner.accessToken });
}

it.each(['disable', 'remove'] as const)(
  'does not execute a pending delete after workflow %s',
  async (operation) => {
    const harness = await createHarness();
    try {
      const owner = await registerAccount(harness);
      const { documentId, workflowId } = await setup(harness, owner, 'always_ask');
      const evaluated = await harness.api.json('POST', '/api/v1/workflows/evaluate', {
        token: owner.accessToken,
        body: { trigger: 'document.approved', documentId },
      });
      const run = evaluated.json<{ runs: Array<{ id: string; status: string }> }>().runs[0]!;
      expect(run.status).toBe('awaiting_approval');
      expect((await change(harness, owner, workflowId, operation)).statusCode).toBe(
        operation === 'disable' ? 200 : 204,
      );
      const response = await harness.api.json('POST', `/api/v1/workflows/runs/${run.id}/approve`, {
        token: owner.accessToken,
      });
      expect(response.statusCode).toBe(409);
      expect(
        await harness.db.one('SELECT status, outputs FROM workflow_runs WHERE id = ?', [run.id]),
      ).toEqual({ status: 'failed', outputs: '[]' });
      expect(
        await harness.db.one('SELECT deleted_at FROM documents WHERE id = ?', [documentId]),
      ).toEqual({ deleted_at: null });
      expect(
        await harness.db.query('SELECT id FROM audit_logs WHERE action = ? AND target_id = ?', [
          'document.deleted',
          documentId,
        ]),
      ).toHaveLength(0);
    } finally {
      await harness.close();
    }
  },
);

it.each(['disable', 'remove'] as const)(
  'fails an automatic plan if the workflow is changed to %s before execution',
  async (operation) => {
    const harness = await createHarness();
    try {
      const owner = await registerAccount(harness);
      const { documentId, workflowId } = await setup(harness, owner, 'auto_approve');
      const original = WorkflowRunsRepository.prototype.create;
      const spy = jest
        .spyOn(WorkflowRunsRepository.prototype, 'create')
        .mockImplementation(async function (this: WorkflowRunsRepository, input) {
          const run = await original.call(this, input);
          expect((await change(harness, owner, workflowId, operation)).statusCode).toBe(
            operation === 'disable' ? 200 : 204,
          );
          return run;
        });
      try {
        const response = await harness.api.json('POST', '/api/v1/workflows/evaluate', {
          token: owner.accessToken,
          body: { trigger: 'document.approved', documentId },
        });
        expect(response.statusCode).toBe(200);
        expect(response.json<{ runs: Array<{ status: string }> }>().runs[0]!.status).toBe('failed');
        expect(
          await harness.db.one('SELECT deleted_at FROM documents WHERE id = ?', [documentId]),
        ).toEqual({ deleted_at: null });
        expect(
          await harness.db.query('SELECT id FROM audit_logs WHERE action = ? AND target_id = ?', [
            'document.deleted',
            documentId,
          ]),
        ).toHaveLength(0);
      } finally {
        spy.mockRestore();
      }
    } finally {
      await harness.close();
    }
  },
);

it('characterizes that disabling and re-enabling does not invalidate an untouched pending run', async () => {
  const harness = await createHarness();
  try {
    const owner = await registerAccount(harness);
    const { documentId, workflowId } = await setup(harness, owner, 'always_ask');
    const evaluated = await harness.api.json('POST', '/api/v1/workflows/evaluate', {
      token: owner.accessToken,
      body: { trigger: 'document.approved', documentId },
    });
    const run = evaluated.json<{ runs: Array<{ id: string }> }>().runs[0]!;
    expect((await change(harness, owner, workflowId, 'disable')).statusCode).toBe(200);
    expect(
      (
        await harness.api.json('PATCH', `/api/v1/workflows/${workflowId}`, {
          token: owner.accessToken,
          body: { enabled: true },
        })
      ).statusCode,
    ).toBe(200);
    const response = await harness.api.json('POST', `/api/v1/workflows/runs/${run.id}/approve`, {
      token: owner.accessToken,
    });
    // Known limitation: this test characterizes current behavior, not a safety guarantee.
    expect(response.statusCode).toBe(200);
    const row = await harness.db.one<{ deleted_at: string | null }>(
      'SELECT deleted_at FROM documents WHERE id = ?',
      [documentId],
    );
    expect(row?.deleted_at).not.toBeNull();
  } finally {
    await harness.close();
  }
});
