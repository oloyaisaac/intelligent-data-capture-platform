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

it.each(['before', 'after'] as const)(
  'fails an automatic plan when toggled %s run creation',
  async (timing) => {
    const harness = await createHarness();
    try {
      const owner = await registerAccount(harness);
      const { documentId, workflowId } = await setup(harness, owner, 'auto_approve');
      const toggle = async () => {
        expect((await change(harness, owner, workflowId, 'disable')).statusCode).toBe(200);
        expect(
          (
            await harness.api.json('PATCH', `/api/v1/workflows/${workflowId}`, {
              token: owner.accessToken,
              body: { enabled: true },
            })
          ).statusCode,
        ).toBe(200);
      };
      const original = WorkflowRunsRepository.prototype.create;
      const spy = jest
        .spyOn(WorkflowRunsRepository.prototype, 'create')
        .mockImplementation(async function (this: WorkflowRunsRepository, input) {
          if (timing === 'before') await toggle();
          const run = await original.call(this, input);
          if (timing === 'after') await toggle();
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

it('invalidates a pending run even when an enable request leaves the workflow enabled', async () => {
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
    expect(
      (
        await harness.api.json('PATCH', `/api/v1/workflows/${workflowId}`, {
          token: owner.accessToken,
          body: { enabled: true },
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (
        await harness.api.json('POST', `/api/v1/workflows/runs/${run.id}/approve`, {
          token: owner.accessToken,
        })
      ).statusCode,
    ).toBe(409);
    expect(await harness.db.one('SELECT status FROM workflow_runs WHERE id = ?', [run.id])).toEqual(
      { status: 'failed' },
    );
    expect(
      await harness.db.one('SELECT deleted_at FROM documents WHERE id = ?', [documentId]),
    ).toEqual({ deleted_at: null });
  } finally {
    await harness.close();
  }
});

it('increments the revision for concurrent enable requests without losing an update', async () => {
  const harness = await createHarness();
  try {
    const owner = await registerAccount(harness);
    const { documentId, workflowId } = await setup(harness, owner, 'always_ask');
    const evaluated = await harness.api.json('POST', '/api/v1/workflows/evaluate', {
      token: owner.accessToken,
      body: { trigger: 'document.approved', documentId },
    });
    const run = evaluated.json<{ runs: Array<{ id: string }> }>().runs[0]!;
    const patch = () =>
      harness.api.json('PATCH', `/api/v1/workflows/${workflowId}`, {
        token: owner.accessToken,
        body: { enabled: true },
      });
    expect((await Promise.all([patch(), patch()])).map((response) => response.statusCode)).toEqual([
      200, 200,
    ]);
    const current = await harness.db.one<{ revision: number | string }>(
      'SELECT revision FROM workflows WHERE id = ?',
      [workflowId],
    );
    expect(Number(current?.revision)).toBe(2);
    expect(
      (
        await harness.api.json('POST', `/api/v1/workflows/runs/${run.id}/approve`, {
          token: owner.accessToken,
        })
      ).statusCode,
    ).toBe(409);
    expect(
      await harness.db.one('SELECT deleted_at FROM documents WHERE id = ?', [documentId]),
    ).toEqual({ deleted_at: null });
  } finally {
    await harness.close();
  }
});

it('does not revive a pending run when the workflow is disabled and re-enabled', async () => {
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
    expect(response.statusCode).toBe(409);
    expect(
      await harness.db.one('SELECT deleted_at FROM documents WHERE id = ?', [documentId]),
    ).toEqual({ deleted_at: null });
    expect(
      await harness.db.one('SELECT status, outputs FROM workflow_runs WHERE id = ?', [run.id]),
    ).toEqual({ status: 'failed', outputs: '[]' });
    expect(
      await harness.db.query('SELECT id FROM audit_logs WHERE action = ? AND target_id = ?', [
        'document.deleted',
        documentId,
      ]),
    ).toHaveLength(0);
    const fresh = await harness.api.json('POST', '/api/v1/workflows/evaluate', {
      token: owner.accessToken,
      body: { trigger: 'document.approved', documentId },
    });
    const freshRun = fresh.json<{ runs: Array<{ id: string; status: string }> }>().runs[0]!;
    expect(freshRun.status).toBe('awaiting_approval');
    expect(
      (
        await harness.api.json('POST', `/api/v1/workflows/runs/${freshRun.id}/approve`, {
          token: owner.accessToken,
        })
      ).statusCode,
    ).toBe(200);
  } finally {
    await harness.close();
  }
});
