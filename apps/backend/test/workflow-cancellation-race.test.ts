import { AuditRepository } from '../src/repositories/system-repo';
import { WorkflowRunsRepository } from '../src/repositories/workflow-repo';
import { approveDocument, SAMPLE_INVOICE_TEXT, createHarness, registerAccount } from './helpers';

it('prevents a paused original execution from acting after its run is cancelled', async () => {
  const harness = await createHarness();
  let release!: () => void;
  let created!: (id: string) => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const runCreated = new Promise<string>((resolve) => {
    created = resolve;
  });
  try {
    const account = await registerAccount(harness);
    const document = await harness.api.upload(account.accessToken);
    const documentId = document.json<{ id: string }>().id;
    harness.ocr.setText(SAMPLE_INVOICE_TEXT);
    await harness.services.worker.drain();
    await approveDocument(harness, account, documentId);
    const workflow = await harness.api.json('POST', '/api/v1/workflows', {
      token: account.accessToken,
      body: {
        name: 'Auto delete',
        trigger: 'document.approved',
        conditions: [],
        approvalPolicy: 'auto_approve',
        actions: [{ type: 'delete_document' }],
      },
    });
    expect(workflow.statusCode).toBe(201);
    const original = WorkflowRunsRepository.prototype.create;
    const spy = jest
      .spyOn(WorkflowRunsRepository.prototype, 'create')
      .mockImplementation(async function (this: WorkflowRunsRepository, input) {
        const row = await original.call(this, input);
        created(row.id);
        await gate;
        return row;
      });
    const evaluation = harness.api.json('POST', '/api/v1/workflows/evaluate', {
      token: account.accessToken,
      body: { trigger: 'document.approved', documentId },
    });
    try {
      const runId = await runCreated;
      const cancelled = await harness.api.json(
        'POST',
        `/api/v1/workflows/runs/${runId}/cancel-interrupted`,
        {
          token: account.accessToken,
          body: { confirmReviewed: true, incidentReference: 'INC-99' },
        },
      );
      expect(cancelled.statusCode).toBe(200);
      release();
      // The original caller may see an ambiguous failure, but it must not perform the delete.
      expect((await evaluation).statusCode).toBe(500);
      expect(
        await harness.db.one('SELECT status FROM workflow_runs WHERE id = ?', [runId]),
      ).toEqual({ status: 'failed' });
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
        await harness.db.query('SELECT id FROM audit_logs WHERE action = ?', [
          'workflow.run_cancelled_interrupted',
        ]),
      ).toHaveLength(1);
    } finally {
      release();
      await evaluation.catch(() => undefined);
      spy.mockRestore();
    }
  } finally {
    await harness.close();
  }
}, 15_000);

it('does not overwrite or duplicate a committed cancellation after lost acknowledgement', async () => {
  const harness = await createHarness();
  try {
    const account = await registerAccount(harness);
    const document = await harness.api.upload(account.accessToken);
    const documentId = document.json<{ id: string }>().id;
    harness.ocr.setText(SAMPLE_INVOICE_TEXT);
    await harness.services.worker.drain();
    await approveDocument(harness, account, documentId);
    const workflow = await harness.api.json('POST', '/api/v1/workflows', {
      token: account.accessToken,
      body: {
        name: 'Auto delete',
        trigger: 'document.approved',
        conditions: [],
        approvalPolicy: 'auto_approve',
        actions: [{ type: 'delete_document' }],
      },
    });
    const workflowId = workflow.json<{ id: string }>().id;
    const originalAudit = AuditRepository.prototype.record;
    const failExecution = jest
      .spyOn(AuditRepository.prototype, 'record')
      .mockImplementation(async function (this: AuditRepository, input) {
        if (input.action === 'workflow.run_completed') throw new Error('synthetic');
        return originalAudit.call(this, input);
      });
    try {
      expect(
        (
          await harness.api.json('POST', '/api/v1/workflows/evaluate', {
            token: account.accessToken,
            body: { trigger: 'document.approved', documentId },
          })
        ).statusCode,
      ).toBe(500);
    } finally {
      failExecution.mockRestore();
    }
    const row = await harness.db.one<{ id: string }>(
      'SELECT id FROM workflow_runs WHERE workflow_id = ?',
      [workflowId],
    );
    const runId = row!.id;
    const originalTransaction = harness.db.transaction.bind(harness.db);
    let committed = false;
    const audit = jest
      .spyOn(AuditRepository.prototype, 'record')
      .mockImplementation(async function (this: AuditRepository, input) {
        await originalAudit.call(this, input);
        if (input.action === 'workflow.run_cancelled_interrupted') committed = true;
      });
    const transaction = jest.spyOn(harness.db, 'transaction').mockImplementation(async (run) => {
      const result = await originalTransaction(run);
      if (committed) {
        committed = false;
        throw new Error('synthetic secret lost acknowledgement');
      }
      return result;
    });
    const cancel = () =>
      harness.api.json('POST', `/api/v1/workflows/runs/${runId}/cancel-interrupted`, {
        token: account.accessToken,
        body: { confirmReviewed: true, incidentReference: 'INC-99' },
      });
    try {
      const result = await cancel();
      expect(result.statusCode).toBe(500);
      expect(result.body).not.toContain('synthetic secret');
    } finally {
      transaction.mockRestore();
      audit.mockRestore();
    }
    expect((await cancel()).statusCode).toBe(409);
    expect(await harness.db.one('SELECT status FROM workflow_runs WHERE id = ?', [runId])).toEqual({
      status: 'failed',
    });
    expect(
      await harness.db.one('SELECT deleted_at FROM documents WHERE id = ?', [documentId]),
    ).toEqual({ deleted_at: null });
    expect(
      await harness.db.query('SELECT id FROM audit_logs WHERE action = ? AND target_id = ?', [
        'workflow.run_cancelled_interrupted',
        workflowId,
      ]),
    ).toHaveLength(1);
  } finally {
    await harness.close();
  }
}, 15_000);
