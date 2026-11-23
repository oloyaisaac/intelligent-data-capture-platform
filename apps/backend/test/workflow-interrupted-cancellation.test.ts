import { AuditRepository } from '../src/repositories/system-repo';
import {
  approveDocument,
  SAMPLE_INVOICE_TEXT,
  createHarness,
  registerAccount,
  type Harness,
  type TestAccount,
} from './helpers';

async function interruptedRun(harness: Harness, account: TestAccount) {
  const upload = await harness.api.upload(account.accessToken);
  const documentId = upload.json<{ id: string }>().id;
  harness.ocr.setText(SAMPLE_INVOICE_TEXT);
  await harness.services.worker.drain();
  await approveDocument(harness, account, documentId);
  const workflow = await harness.api.json('POST', '/api/v1/workflows', {
    token: account.accessToken,
    body: {
      name: 'Automatic delete',
      trigger: 'document.approved',
      conditions: [],
      approvalPolicy: 'auto_approve',
      actions: [{ type: 'delete_document' }],
    },
  });
  expect(workflow.statusCode).toBe(201);
  const workflowId = workflow.json<{ id: string }>().id;
  const original = AuditRepository.prototype.record;
  const spy = jest.spyOn(AuditRepository.prototype, 'record').mockImplementation(async function (
    this: AuditRepository,
    input,
  ) {
    if (input.action === 'workflow.run_completed')
      throw new Error('synthetic execution audit failure');
    return original.call(this, input);
  });
  try {
    const result = await harness.api.json('POST', '/api/v1/workflows/evaluate', {
      token: account.accessToken,
      body: { trigger: 'document.approved', documentId },
    });
    expect(result.statusCode).toBe(500);
  } finally {
    spy.mockRestore();
  }
  const run = await harness.db.one<{ id: string; status: string; execution_protocol: number }>(
    'SELECT id, status, execution_protocol FROM workflow_runs WHERE workflow_id = ?',
    [workflowId],
  );
  expect(run).toMatchObject({ status: 'matched', execution_protocol: 1 });
  return { runId: run!.id, documentId, workflowId };
}

it('cancels only a reviewed current-protocol run and records the owner and incident atomically', async () => {
  const harness = await createHarness();
  try {
    const account = await registerAccount(harness);
    const { runId, documentId, workflowId } = await interruptedRun(harness, account);
    const inspect = await harness.api.get(`/api/v1/workflows/runs/${runId}`, account.accessToken);
    expect(inspect.statusCode).toBe(200);
    expect(inspect.json()).toMatchObject({ id: runId, status: 'matched', executionProtocol: 1 });
    const missing = await harness.api.json(
      'POST',
      `/api/v1/workflows/runs/${runId}/cancel-interrupted`,
      { token: account.accessToken, body: { incidentReference: 'INC-42' } },
    );
    expect(missing.statusCode).toBe(400);
    const invalid = await harness.api.json(
      'POST',
      `/api/v1/workflows/runs/${runId}/cancel-interrupted`,
      {
        token: account.accessToken,
        body: { confirmReviewed: true, incidentReference: 'invalid secret with spaces' },
      },
    );
    expect(invalid.statusCode).toBe(400);
    const other = await registerAccount(harness);
    const crossTenant = await harness.api.json(
      'POST',
      `/api/v1/workflows/runs/${runId}/cancel-interrupted`,
      { token: other.accessToken, body: { confirmReviewed: true, incidentReference: 'INC-42' } },
    );
    expect(crossTenant.statusCode).toBe(404);
    await expect(
      harness.services.workflows.cancelInterruptedRun(
        {
          organisationId: account.organisationId,
          userId: account.userId,
          role: 'owner',
          actorType: 'api_key',
        },
        runId,
        { confirmReviewed: true, incidentReference: 'INC-42' },
      ),
    ).rejects.toMatchObject({ code: 'ROLE_REQUIRED' });
    await expect(
      harness.services.workflows.cancelInterruptedRun(
        {
          organisationId: account.organisationId,
          userId: account.userId,
          role: 'reviewer',
          actorType: 'user',
        },
        runId,
        { confirmReviewed: true, incidentReference: 'INC-42' },
      ),
    ).rejects.toMatchObject({ code: 'ROLE_REQUIRED' });
    const cancel = () =>
      harness.api.json('POST', `/api/v1/workflows/runs/${runId}/cancel-interrupted`, {
        token: account.accessToken,
        body: { confirmReviewed: true, incidentReference: 'INC-42' },
      });
    const results = await Promise.all([cancel(), cancel()]);
    expect(results.map((result) => result.statusCode).sort()).toEqual([200, 409]);
    expect(await harness.db.one('SELECT status FROM workflow_runs WHERE id = ?', [runId])).toEqual({
      status: 'failed',
    });
    expect(
      await harness.db.one('SELECT deleted_at FROM documents WHERE id = ?', [documentId]),
    ).toEqual({ deleted_at: null });
    const audits = await harness.db.query<{ actor_id: string; metadata: string }>(
      'SELECT actor_id, metadata FROM audit_logs WHERE action = ? AND target_id = ?',
      ['workflow.run_cancelled_interrupted', workflowId],
    );
    expect(audits).toHaveLength(1);
    expect(audits[0]?.actor_id).toBe(account.userId);
    expect(JSON.parse(audits[0]!.metadata)).toEqual({
      runId,
      incidentReference: 'INC-42',
      executionProtocol: 1,
    });
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

it('rejects legacy and inconsistent matched rows without changing them', async () => {
  const harness = await createHarness();
  try {
    const account = await registerAccount(harness);
    const { runId, documentId } = await interruptedRun(harness, account);
    const cancel = () =>
      harness.api.json('POST', `/api/v1/workflows/runs/${runId}/cancel-interrupted`, {
        token: account.accessToken,
        body: { confirmReviewed: true, incidentReference: 'INC-42' },
      });
    await harness.db.execute('UPDATE workflow_runs SET execution_protocol = 0 WHERE id = ?', [
      runId,
    ]);
    expect((await cancel()).statusCode).toBe(409);
    await harness.db.execute(
      'UPDATE workflow_runs SET execution_protocol = 1, outputs = \'["already done"]\' WHERE id = ?',
      [runId],
    );
    expect((await cancel()).statusCode).toBe(409);
    await harness.db.execute('UPDATE workflow_runs SET outputs = ?, actions = ? WHERE id = ?', [
      '[]',
      'not valid json',
      runId,
    ]);
    expect((await cancel()).statusCode).toBe(409);
    await harness.db.execute('UPDATE workflow_runs SET actions = ? WHERE id = ?', [
      '[{"type":"send_to_connector"}]',
      runId,
    ]);
    expect((await cancel()).statusCode).toBe(409);
    expect(await harness.db.one('SELECT status FROM workflow_runs WHERE id = ?', [runId])).toEqual({
      status: 'matched',
    });
    expect(
      await harness.db.one('SELECT deleted_at FROM documents WHERE id = ?', [documentId]),
    ).toEqual({ deleted_at: null });
    expect(
      await harness.db.query('SELECT id FROM audit_logs WHERE action = ?', [
        'workflow.run_cancelled_interrupted',
      ]),
    ).toHaveLength(0);
  } finally {
    await harness.close();
  }
});

it('rolls back cancellation on audit failure and does not expose the error', async () => {
  const harness = await createHarness();
  try {
    const account = await registerAccount(harness);
    const { runId, documentId } = await interruptedRun(harness, account);
    const original = AuditRepository.prototype.record;
    const spy = jest.spyOn(AuditRepository.prototype, 'record').mockImplementation(async function (
      this: AuditRepository,
      input,
    ) {
      if (input.action === 'workflow.run_cancelled_interrupted')
        throw new Error('synthetic secret audit failure');
      return original.call(this, input);
    });
    try {
      const response = await harness.api.json(
        'POST',
        `/api/v1/workflows/runs/${runId}/cancel-interrupted`,
        {
          token: account.accessToken,
          body: { confirmReviewed: true, incidentReference: 'INC-42' },
        },
      );
      expect(response.statusCode).toBe(500);
      expect(response.body).not.toContain('synthetic secret');
    } finally {
      spy.mockRestore();
    }
    expect(await harness.db.one('SELECT status FROM workflow_runs WHERE id = ?', [runId])).toEqual({
      status: 'matched',
    });
    expect(
      await harness.db.one('SELECT deleted_at FROM documents WHERE id = ?', [documentId]),
    ).toEqual({ deleted_at: null });
    expect(
      await harness.db.query('SELECT id FROM audit_logs WHERE action = ?', [
        'workflow.run_cancelled_interrupted',
      ]),
    ).toHaveLength(0);
  } finally {
    await harness.close();
  }
});
