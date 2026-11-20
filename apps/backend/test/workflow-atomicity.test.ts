import { AuditRepository } from '../src/repositories/system-repo';
import { createHarness, registerAccount } from './helpers';

it('rolls back earlier actions and audits when a later delete fails', async () => {
  const harness = await createHarness();
  try {
    const account = await registerAccount(harness);
    const upload = await harness.api.upload(account.accessToken);
    const documentId = upload.json<{ id: string }>().id;
    const created = await harness.api.json('POST', '/api/v1/workflows', {
      token: account.accessToken,
      body: {
        name: 'Two deletes',
        trigger: 'document.extracted',
        conditions: [],
        actions: [{ type: 'delete_document' }, { type: 'delete_document' }],
      },
    });
    expect(created.statusCode).toBe(201);
    const evaluation = await harness.api.json('POST', '/api/v1/workflows/evaluate', {
      token: account.accessToken,
      body: { trigger: 'document.extracted', documentId },
    });
    const runId = evaluation.json<{ runs: Array<{ id: string }> }>().runs[0]!.id;
    const response = await harness.api.json('POST', `/api/v1/workflows/runs/${runId}/approve`, {
      token: account.accessToken,
    });
    expect(response.statusCode).toBe(409);
    expect(
      await harness.db.one('SELECT status, outputs FROM workflow_runs WHERE id = ?', [runId]),
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
});

it('commits an automatic deletion and both audits with its completed result', async () => {
  const harness = await createHarness();
  try {
    const account = await registerAccount(harness);
    const upload = await harness.api.upload(account.accessToken);
    const documentId = upload.json<{ id: string }>().id;
    const created = await harness.api.json('POST', '/api/v1/workflows', {
      token: account.accessToken,
      body: {
        name: 'Automatic delete',
        trigger: 'document.extracted',
        conditions: [],
        approvalPolicy: 'auto_approve',
        actions: [{ type: 'delete_document' }],
      },
    });
    const workflowId = created.json<{ id: string }>().id;
    const evaluation = await harness.api.json('POST', '/api/v1/workflows/evaluate', {
      token: account.accessToken,
      body: { trigger: 'document.extracted', documentId },
    });
    expect(evaluation.statusCode).toBe(200);
    const run = evaluation.json<{ runs: Array<{ status: string; outputs: string[] }> }>().runs[0]!;
    expect(run.status).toBe('completed');
    expect(run.outputs).toEqual([`deleted document ${documentId}`]);
    expect(
      await harness.db.query('SELECT id FROM audit_logs WHERE action = ? AND target_id = ?', [
        'workflow.run_completed',
        workflowId,
      ]),
    ).toHaveLength(1);
    expect(
      await harness.db.query('SELECT id FROM audit_logs WHERE action = ? AND target_id = ?', [
        'document.deleted',
        documentId,
      ]),
    ).toHaveLength(1);
  } finally {
    await harness.close();
  }
});

it('does not report an automatic run completed when its audit fails', async () => {
  const harness = await createHarness();
  try {
    const account = await registerAccount(harness);
    const upload = await harness.api.upload(account.accessToken);
    const documentId = upload.json<{ id: string }>().id;
    const created = await harness.api.json('POST', '/api/v1/workflows', {
      token: account.accessToken,
      body: {
        name: 'Automatic delete',
        trigger: 'document.extracted',
        conditions: [],
        approvalPolicy: 'auto_approve',
        actions: [{ type: 'delete_document' }],
      },
    });
    expect(created.statusCode).toBe(201);
    const workflowId = created.json<{ id: string }>().id;
    const original = AuditRepository.prototype.record;
    const spy = jest.spyOn(AuditRepository.prototype, 'record').mockImplementation(async function (
      this: AuditRepository,
      input,
    ) {
      if (input.action === 'workflow.run_completed') throw new Error('secret synthetic failure');
      return original.call(this, input);
    });
    try {
      const response = await harness.api.json('POST', '/api/v1/workflows/evaluate', {
        token: account.accessToken,
        body: { trigger: 'document.extracted', documentId },
      });
      expect(response.statusCode).toBe(500);
      expect(response.body).not.toContain('secret synthetic failure');
    } finally {
      spy.mockRestore();
    }
    expect(
      await harness.db.one('SELECT status, outputs FROM workflow_runs WHERE workflow_id = ?', [
        workflowId,
      ]),
    ).toEqual({ status: 'matched', outputs: '[]' });
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
});

it('does not overwrite committed approval if the commit acknowledgement is lost', async () => {
  const harness = await createHarness();
  try {
    const account = await registerAccount(harness);
    const upload = await harness.api.upload(account.accessToken);
    const documentId = upload.json<{ id: string }>().id;
    const created = await harness.api.json('POST', '/api/v1/workflows', {
      token: account.accessToken,
      body: {
        name: 'Delete',
        trigger: 'document.extracted',
        conditions: [],
        actions: [{ type: 'delete_document' }],
      },
    });
    const evaluation = await harness.api.json('POST', '/api/v1/workflows/evaluate', {
      token: account.accessToken,
      body: { trigger: 'document.extracted', documentId },
    });
    const runId = evaluation.json<{ runs: Array<{ id: string }> }>().runs[0]!.id;
    const workflowId = created.json<{ id: string }>().id;
    const originalAudit = AuditRepository.prototype.record;
    const originalTransaction = harness.db.transaction.bind(harness.db);
    let committed = false;
    const audit = jest
      .spyOn(AuditRepository.prototype, 'record')
      .mockImplementation(async function (this: AuditRepository, input) {
        await originalAudit.call(this, input);
        if (input.action === 'workflow.run_approved') committed = true;
      });
    const transaction = jest.spyOn(harness.db, 'transaction').mockImplementation(async (run) => {
      const result = await originalTransaction(run);
      if (committed) {
        committed = false;
        throw new Error('secret lost acknowledgement');
      }
      return result;
    });
    try {
      const response = await harness.api.json('POST', `/api/v1/workflows/runs/${runId}/approve`, {
        token: account.accessToken,
      });
      expect(response.statusCode).toBe(500);
      expect(response.body).not.toContain('secret lost acknowledgement');
    } finally {
      transaction.mockRestore();
      audit.mockRestore();
    }
    expect(await harness.db.one('SELECT status FROM workflow_runs WHERE id = ?', [runId])).toEqual({
      status: 'completed',
    });
    const retry = await harness.api.json('POST', `/api/v1/workflows/runs/${runId}/approve`, {
      token: account.accessToken,
    });
    expect(retry.statusCode).toBe(409);
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
  } finally {
    await harness.close();
  }
});
