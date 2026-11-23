import { JobsRepository } from '../src/repositories/system-repo';
import { ReviewsRepository } from '../src/repositories/review-repo';
import { WorkflowRunsRepository } from '../src/repositories/workflow-repo';
import {
  approveDocument,
  createHarness,
  fakePng,
  registerAccount,
  SAMPLE_INVOICE_TEXT,
  type Harness,
  type TestAccount,
} from './helpers';

// Explicitly marked characterization tests describe remaining unsafe behavior, not desired behavior.
describe('workflow trigger and snapshot safety (ARC-042)', () => {
  let harness: Harness;
  let owner: TestAccount;

  beforeEach(async () => {
    harness = await createHarness();
    owner = await registerAccount(harness);
    harness.ocr.setText(SAMPLE_INVOICE_TEXT);
  });
  afterEach(async () => {
    await harness.close();
  });

  async function document() {
    const response = await harness.api.upload(owner.accessToken, { content: fakePng('trigger') });
    expect(response.statusCode).toBe(201);
    const id = response.json<{ id: string }>().id;
    await harness.services.worker.drain();
    return id;
  }

  async function workflow(trigger: string, approvalPolicy: string) {
    const response = await harness.api.json('POST', '/api/v1/workflows', {
      token: owner.accessToken,
      body: {
        name: 'Synthetic delete',
        trigger,
        conditions: [],
        actions: [{ type: 'delete_document', config: {} }],
        approvalPolicy,
      },
    });
    expect(response.statusCode).toBe(201);
    return response.json<{ id: string }>().id;
  }

  async function evaluate(trigger: string, documentId: string) {
    const response = await harness.api.json('POST', '/api/v1/workflows/evaluate', {
      token: owner.accessToken,
      body: { trigger, documentId },
    });
    expect(response.statusCode).toBe(200);
    return response.json<{ runs: Array<{ id: string; status: string }> }>().runs[0]!;
  }

  it('rejects an approved-trigger evaluation for an unapproved or absent document without creating a run', async () => {
    await workflow('document.approved', 'auto_approve');
    const id = await document();
    for (const documentId of [id, undefined]) {
      const response = await harness.api.json('POST', '/api/v1/workflows/evaluate', {
        token: owner.accessToken,
        body: { trigger: 'document.approved', documentId },
      });
      expect(response.statusCode).toBe(409);
    }
    expect(
      await harness.db.one('SELECT status, deleted_at FROM documents WHERE id = ?', [id]),
    ).toEqual({
      status: 'needs_review',
      deleted_at: null,
    });
    expect(
      await harness.db.query('SELECT id FROM workflow_runs WHERE organisation_id = ?', [
        owner.organisationId,
      ]),
    ).toHaveLength(0);
  });

  it('rejects evaluations when approval is stale, deleted, or extraction is active', async () => {
    await workflow('document.approved', 'auto_approve');
    const id = await document();
    await approveDocument(harness, owner, id);
    const job = await new JobsRepository(harness.db).enqueue({
      organisationId: owner.organisationId,
      type: 'extract_document',
      documentId: id,
    });
    const request = () =>
      harness.api.json('POST', '/api/v1/workflows/evaluate', {
        token: owner.accessToken,
        body: { trigger: 'document.approved', documentId: id },
      });
    expect((await request()).statusCode).toBe(409);
    await harness.db.execute('DELETE FROM jobs WHERE id = ?', [job.id]);
    expect(
      (
        await harness.api.json('POST', `/api/v1/documents/${id}/reprocess`, {
          token: owner.accessToken,
        })
      ).statusCode,
    ).toBe(202);
    await harness.services.worker.drain();
    // Status alone is insufficient: the approval is for the previous extraction.
    await harness.db.execute("UPDATE documents SET status = 'approved' WHERE id = ?", [id]);
    expect((await request()).statusCode).toBe(409);
    await harness.db.execute('UPDATE documents SET deleted_at = ? WHERE id = ?', [
      new Date().toISOString(),
      id,
    ]);
    expect((await request()).statusCode).toBe(409);
    expect(
      await harness.db.query('SELECT id FROM workflow_runs WHERE organisation_id = ?', [
        owner.organisationId,
      ]),
    ).toHaveLength(0);
  });

  it('fails an automatic run if reprocessing starts between evaluation and execution', async () => {
    await workflow('document.approved', 'auto_approve');
    const id = await document();
    await approveDocument(harness, owner, id);
    const original = WorkflowRunsRepository.prototype.create;
    const spy = jest
      .spyOn(WorkflowRunsRepository.prototype, 'create')
      .mockImplementation(async function (this: WorkflowRunsRepository, input) {
        const run = await original.call(this, input);
        const response = await harness.api.json('POST', `/api/v1/documents/${id}/reprocess`, {
          token: owner.accessToken,
        });
        expect(response.statusCode).toBe(202);
        return run;
      });
    try {
      const run = await evaluate('document.approved', id);
      expect(run.status).toBe('failed');
      expect(
        await harness.db.one('SELECT status, deleted_at FROM documents WHERE id = ?', [id]),
      ).toEqual({ status: 'queued', deleted_at: null });
    } finally {
      spy.mockRestore();
    }
  });

  it('fails an automatic run if a newer approval replaces its snapshot before planning finishes', async () => {
    await workflow('document.approved', 'auto_approve');
    const id = await document();
    await approveDocument(harness, owner, id);
    const original = ReviewsRepository.prototype.findWorkflowApprovalSnapshot;
    let oldExtraction: string | undefined;
    const spy = jest
      .spyOn(ReviewsRepository.prototype, 'findWorkflowApprovalSnapshot')
      .mockImplementationOnce(async function (this: ReviewsRepository, organisationId, documentId) {
        const snapshot = await original.call(this, organisationId, documentId);
        oldExtraction = snapshot?.extractionId;
        expect(
          (
            await harness.api.json('POST', `/api/v1/documents/${id}/reprocess`, {
              token: owner.accessToken,
            })
          ).statusCode,
        ).toBe(202);
        await harness.services.worker.drain();
        await approveDocument(harness, owner, id);
        return snapshot;
      });
    try {
      const run = await evaluate('document.approved', id);
      expect(run.status).toBe('failed');
      const stored = await harness.db.one<{ approval_snapshot: string }>(
        'SELECT approval_snapshot FROM workflow_runs WHERE id = ?',
        [run.id],
      );
      expect(JSON.parse(stored!.approval_snapshot).extractionId).toBe(oldExtraction);
      const current = await harness.db.one<{ id: string }>(
        'SELECT id FROM extractions WHERE document_id = ? ORDER BY attempt DESC LIMIT 1',
        [id],
      );
      expect(current?.id).not.toBe(oldExtraction);
      expect(
        await harness.db.one('SELECT status, deleted_at FROM documents WHERE id = ?', [id]),
      ).toEqual({ status: 'approved', deleted_at: null });
    } finally {
      spy.mockRestore();
    }
  });

  it.each(['auto_approve', 'always_ask'])(
    'fails a batch-trigger deletion under %s without deleting the supplied document',
    async (policy) => {
      const workflowId = await workflow('batch.completed', policy);
      const id = await document();
      const run = await evaluate('batch.completed', id);
      expect(run.status).toBe('failed');
      expect(await harness.db.one('SELECT deleted_at FROM documents WHERE id = ?', [id])).toEqual({
        deleted_at: null,
      });
      expect(
        await harness.db.query('SELECT id FROM audit_logs WHERE action = ? AND target_id = ?', [
          'document.deleted',
          id,
        ]),
      ).toHaveLength(0);
      expect(
        await harness.db.one('SELECT status, outputs FROM workflow_runs WHERE id = ?', [run.id]),
      ).toEqual({ status: 'failed', outputs: '[]' });
      const failed = await harness.db.one<{ failure: string }>(
        'SELECT failure FROM workflow_runs WHERE id = ?',
        [run.id],
      );
      expect(failed?.failure).toMatch(/Batch-trigger document deletion is unavailable/);
      expect(
        await harness.db.query('SELECT id FROM workflow_runs WHERE workflow_id = ?', [workflowId]),
      ).toHaveLength(1);
    },
  );

  it.each(['batch.completed', 'document.extracted', 'document.needs_review'])(
    'fails the whole mixed %s plan before executing any action',
    async (trigger) => {
      const created = await harness.api.json('POST', '/api/v1/workflows', {
        token: owner.accessToken,
        body: {
          name: 'Mixed',
          trigger,
          conditions: [],
          approvalPolicy: 'auto_approve',
          actions: [{ type: 'delete_document' }, { type: 'notify' }],
        },
      });
      expect(created.statusCode).toBe(201);
      const id = await document();
      const run = await evaluate(trigger, id);
      expect(run.status).toBe('failed');
      expect(await harness.db.one('SELECT deleted_at FROM documents WHERE id = ?', [id])).toEqual({
        deleted_at: null,
      });
      expect(
        await harness.db.query('SELECT id FROM audit_logs WHERE action = ? AND target_id = ?', [
          'document.deleted',
          id,
        ]),
      ).toHaveLength(0);
    },
  );

  it.each([
    ['document.extracted', 'auto_approve'],
    ['document.extracted', 'always_ask'],
    ['document.needs_review', 'auto_approve'],
    ['document.needs_review', 'always_ask'],
  ])('fails unverified %s deletion with %s for a queued document', async (trigger, policy) => {
    await workflow(trigger, policy);
    const upload = await harness.api.upload(owner.accessToken, {
      content: fakePng(`unverified-${trigger}`),
    });
    expect(upload.statusCode).toBe(201);
    const id = upload.json<{ id: string }>().id;
    expect(
      await harness.db.one('SELECT status, deleted_at FROM documents WHERE id = ?', [id]),
    ).toEqual({ status: 'queued', deleted_at: null });
    const run = await evaluate(trigger, id);
    expect(run.status).toBe('failed');
    expect(
      await harness.db.one('SELECT status, deleted_at FROM documents WHERE id = ?', [id]),
    ).toEqual({ status: 'queued', deleted_at: null });
    expect(
      await harness.db.query('SELECT id FROM audit_logs WHERE action = ? AND target_id = ?', [
        'document.deleted',
        id,
      ]),
    ).toHaveLength(0);
    expect(
      await harness.db.one('SELECT status, outputs FROM workflow_runs WHERE id = ?', [run.id]),
    ).toEqual({ status: 'failed', outputs: '[]' });
  });

  it('continues recording an unmatched batch workflow as skipped', async () => {
    const created = await harness.api.json('POST', '/api/v1/workflows', {
      token: owner.accessToken,
      body: {
        name: 'No match',
        trigger: 'batch.completed',
        documentType: 'receipt',
        conditions: [],
        approvalPolicy: 'auto_approve',
        actions: [{ type: 'delete_document' }],
      },
    });
    expect(created.statusCode).toBe(201);
    const id = await document();
    const run = await evaluate('batch.completed', id);
    expect(run.status).toBe('skipped');
    expect(await harness.db.one('SELECT deleted_at FROM documents WHERE id = ?', [id])).toEqual({
      deleted_at: null,
    });
  });

  it.each([
    ['batch.completed', 'awaiting_approval'],
    ['batch.completed', 'matched'],
    ['document.extracted', 'awaiting_approval'],
    ['document.extracted', 'matched'],
    ['document.needs_review', 'awaiting_approval'],
    ['document.needs_review', 'matched'],
  ] as const)('does not execute a legacy %s trigger with %s status', async (trigger, status) => {
    const workflowId = await workflow(trigger, 'always_ask');
    const id = await document();
    const run = await new WorkflowRunsRepository(harness.db).create({
      organisationId: owner.organisationId,
      workflowId,
      documentId: id,
      trigger,
      status,
      matched: true,
      explanation: 'historical synthetic plan',
      actions: [{ type: 'delete_document' }],
    });
    if (status === 'awaiting_approval') {
      const response = await harness.api.json('POST', `/api/v1/workflows/runs/${run.id}/approve`, {
        token: owner.accessToken,
      });
      expect(response.statusCode).toBe(409);
      expect(
        await harness.db.one('SELECT status FROM workflow_runs WHERE id = ?', [run.id]),
      ).toEqual({ status: 'failed' });
    } else {
      // Exercise the private automatic execution boundary with a preexisting matched run.
      const service = harness.services.workflows as unknown as {
        executeRun(
          actor: { userId: string; organisationId: string; role: 'owner'; actorType: 'user' },
          id: string,
          expected: 'matched',
        ): Promise<{ status: string }>;
      };
      const result = await service.executeRun(
        {
          userId: owner.userId,
          organisationId: owner.organisationId,
          role: 'owner',
          actorType: 'user',
        },
        run.id,
        'matched',
      );
      expect(result.status).toBe('failed');
    }
    expect(await harness.db.one('SELECT deleted_at FROM documents WHERE id = ?', [id])).toEqual({
      deleted_at: null,
    });
  });

  it('fails closed on a persisted run with an unknown trigger', async () => {
    const workflowId = await workflow('document.extracted', 'always_ask');
    const id = await document();
    const run = await new WorkflowRunsRepository(harness.db).create({
      organisationId: owner.organisationId,
      workflowId,
      documentId: id,
      trigger: 'document.extracted',
      status: 'awaiting_approval',
      matched: true,
      explanation: 'synthetic corrupted trigger',
      actions: [{ type: 'delete_document' }],
    });
    await harness.db.execute('UPDATE workflow_runs SET trigger_event = ? WHERE id = ?', [
      'unknown.trigger',
      run.id,
    ]);
    const response = await harness.api.json('POST', `/api/v1/workflows/runs/${run.id}/approve`, {
      token: owner.accessToken,
    });
    expect(response.statusCode).toBe(409);
    expect(
      await harness.db.one('SELECT status, outputs FROM workflow_runs WHERE id = ?', [run.id]),
    ).toEqual({ status: 'failed', outputs: '[]' });
    expect(await harness.db.one('SELECT deleted_at FROM documents WHERE id = ?', [id])).toEqual({
      deleted_at: null,
    });
  });

  it('rejects an old approved-trigger delete plan while reprocessing is queued', async () => {
    await workflow('document.approved', 'always_ask');
    const id = await document();
    await approveDocument(harness, owner, id);
    const run = await evaluate('document.approved', id);
    expect(run.status).toBe('awaiting_approval');
    const reprocess = await harness.api.json('POST', `/api/v1/documents/${id}/reprocess`, {
      token: owner.accessToken,
    });
    expect(reprocess.statusCode).toBe(202);
    expect(
      await harness.db.one('SELECT status, deleted_at FROM documents WHERE id = ?', [id]),
    ).toEqual({
      status: 'queued',
      deleted_at: null,
    });
    const response = await harness.api.json('POST', `/api/v1/workflows/runs/${run.id}/approve`, {
      token: owner.accessToken,
    });
    expect(response.statusCode).toBe(409);
    expect(await harness.db.one('SELECT deleted_at FROM documents WHERE id = ?', [id])).toEqual({
      deleted_at: null,
    });
    expect(
      await harness.db.one('SELECT status, outputs FROM workflow_runs WHERE id = ?', [run.id]),
    ).toEqual({ status: 'failed', outputs: '[]' });
  });

  it('executes a pending delete when its stored approval and extraction are still current', async () => {
    await workflow('document.approved', 'always_ask');
    const id = await document();
    await approveDocument(harness, owner, id);
    const run = await evaluate('document.approved', id);
    const stored = await harness.db.one<{ approval_snapshot: string }>(
      'SELECT approval_snapshot FROM workflow_runs WHERE id = ?',
      [run.id],
    );
    const review = await harness.db.one<{ id: string; extraction_id: string }>(
      "SELECT id, extraction_id FROM reviews WHERE document_id = ? AND status = 'approved'",
      [id],
    );
    expect(JSON.parse(stored!.approval_snapshot)).toEqual({
      reviewId: review!.id,
      extractionId: review!.extraction_id,
      conditionSemanticsVersion: 1,
      workflowRevision: 0,
    });
    const visible = await harness.api.get(`/api/v1/workflows/runs/${run.id}`, owner.accessToken);
    expect(visible.statusCode).toBe(200);
    expect(visible.json<{ approvalSnapshot: unknown }>().approvalSnapshot).toEqual({
      reviewId: review!.id,
      extractionId: review!.extraction_id,
      conditionSemanticsVersion: 1,
      workflowRevision: 0,
    });
    const response = await harness.api.json('POST', `/api/v1/workflows/runs/${run.id}/approve`, {
      token: owner.accessToken,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json<{ status: string }>().status).toBe('completed');
    const row = await harness.db.one<{ deleted_at: string | null }>(
      'SELECT deleted_at FROM documents WHERE id = ?',
      [id],
    );
    expect(row?.deleted_at).not.toBeNull();
  });

  it.each([
    null,
    'not-json',
    '{}',
    '{"reviewId":"other","extractionId":"other","conditionSemanticsVersion":1,"workflowRevision":0}',
  ])('fails closed for a legacy, malformed or mismatched snapshot %s', async (snapshot) => {
    await workflow('document.approved', 'always_ask');
    const id = await document();
    await approveDocument(harness, owner, id);
    const run = await evaluate('document.approved', id);
    await harness.db.execute('UPDATE workflow_runs SET approval_snapshot = ? WHERE id = ?', [
      snapshot,
      run.id,
    ]);
    const response = await harness.api.json('POST', `/api/v1/workflows/runs/${run.id}/approve`, {
      token: owner.accessToken,
    });
    expect(response.statusCode).toBe(409);
    expect(await harness.db.one('SELECT deleted_at FROM documents WHERE id = ?', [id])).toEqual({
      deleted_at: null,
    });
    expect(
      await harness.db.one('SELECT status, outputs FROM workflow_runs WHERE id = ?', [run.id]),
    ).toEqual({ status: 'failed', outputs: '[]' });
  });

  it.each([undefined, 0, 2, '1', null])(
    'rejects an otherwise current approval snapshot with condition semantics version %s',
    async (conditionSemanticsVersion) => {
      await workflow('document.approved', 'always_ask');
      const id = await document();
      await approveDocument(harness, owner, id);
      const run = await evaluate('document.approved', id);
      const stored = await harness.db.one<{ approval_snapshot: string }>(
        'SELECT approval_snapshot FROM workflow_runs WHERE id = ?',
        [run.id],
      );
      const snapshot = JSON.parse(stored!.approval_snapshot);
      snapshot.conditionSemanticsVersion = conditionSemanticsVersion;
      await harness.db.execute('UPDATE workflow_runs SET approval_snapshot = ? WHERE id = ?', [
        JSON.stringify(snapshot),
        run.id,
      ]);
      const response = await harness.api.json('POST', `/api/v1/workflows/runs/${run.id}/approve`, {
        token: owner.accessToken,
      });
      expect(response.statusCode).toBe(409);
      expect(
        await harness.db.one('SELECT status, outputs FROM workflow_runs WHERE id = ?', [run.id]),
      ).toEqual({ status: 'failed', outputs: '[]' });
      expect(await harness.db.one('SELECT deleted_at FROM documents WHERE id = ?', [id])).toEqual({
        deleted_at: null,
      });
      expect(
        await harness.db.query('SELECT id FROM audit_logs WHERE action = ? AND target_id = ?', [
          'document.deleted',
          id,
        ]),
      ).toHaveLength(0);
    },
  );

  it.each([undefined, null, -1, 0.5, '0', Number.MAX_SAFE_INTEGER + 1, 10])(
    'fails an otherwise current pending plan with missing or invalid workflow revision %s',
    async (workflowRevision) => {
      await workflow('document.approved', 'always_ask');
      const id = await document();
      await approveDocument(harness, owner, id);
      const run = await evaluate('document.approved', id);
      const stored = await harness.db.one<{ approval_snapshot: string }>(
        'SELECT approval_snapshot FROM workflow_runs WHERE id = ?',
        [run.id],
      );
      const snapshot = JSON.parse(stored!.approval_snapshot);
      snapshot.workflowRevision = workflowRevision;
      await harness.db.execute('UPDATE workflow_runs SET approval_snapshot = ? WHERE id = ?', [
        JSON.stringify(snapshot),
        run.id,
      ]);
      const response = await harness.api.json('POST', `/api/v1/workflows/runs/${run.id}/approve`, {
        token: owner.accessToken,
      });
      expect(response.statusCode).toBe(409);
      expect(
        await harness.db.one('SELECT status, outputs FROM workflow_runs WHERE id = ?', [run.id]),
      ).toEqual({ status: 'failed', outputs: '[]' });
      expect(await harness.db.one('SELECT deleted_at FROM documents WHERE id = ?', [id])).toEqual({
        deleted_at: null,
      });
    },
  );

  it('fails an automatic delete if the persisted plan lacks the current condition version', async () => {
    await workflow('document.approved', 'auto_approve');
    const id = await document();
    await approveDocument(harness, owner, id);
    const original = WorkflowRunsRepository.prototype.create;
    const spy = jest
      .spyOn(WorkflowRunsRepository.prototype, 'create')
      .mockImplementation(async function (this: WorkflowRunsRepository, input) {
        const run = await original.call(this, input);
        const snapshot = JSON.parse(run.approval_snapshot!);
        delete snapshot.conditionSemanticsVersion;
        await harness.db.execute('UPDATE workflow_runs SET approval_snapshot = ? WHERE id = ?', [
          JSON.stringify(snapshot),
          run.id,
        ]);
        return run;
      });
    try {
      const run = await evaluate('document.approved', id);
      expect(run.status).toBe('failed');
      expect(await harness.db.one('SELECT deleted_at FROM documents WHERE id = ?', [id])).toEqual({
        deleted_at: null,
      });
      expect(
        await harness.db.query('SELECT id FROM audit_logs WHERE action = ? AND target_id = ?', [
          'document.deleted',
          id,
        ]),
      ).toHaveLength(0);
    } finally {
      spy.mockRestore();
    }
  });

  it('rejects a plan after a newer extraction has been approved', async () => {
    await workflow('document.approved', 'always_ask');
    const id = await document();
    await approveDocument(harness, owner, id);
    const run = await evaluate('document.approved', id);
    expect(run.status).toBe('awaiting_approval');
    const previous = await harness.db.one<{ id: string }>(
      'SELECT id FROM extractions WHERE document_id = ? ORDER BY attempt DESC LIMIT 1',
      [id],
    );
    const reprocess = await harness.api.json('POST', `/api/v1/documents/${id}/reprocess`, {
      token: owner.accessToken,
    });
    expect(reprocess.statusCode).toBe(202);
    await harness.services.worker.drain();
    await approveDocument(harness, owner, id);
    const latest = await harness.db.one<{ id: string }>(
      'SELECT id FROM extractions WHERE document_id = ? ORDER BY attempt DESC LIMIT 1',
      [id],
    );
    expect(latest?.id).not.toBe(previous?.id);
    const response = await harness.api.json('POST', `/api/v1/workflows/runs/${run.id}/approve`, {
      token: owner.accessToken,
    });
    expect(response.statusCode).toBe(409);
    expect(await harness.db.one('SELECT deleted_at FROM documents WHERE id = ?', [id])).toEqual({
      deleted_at: null,
    });
    expect(
      await harness.db.one('SELECT status, outputs FROM workflow_runs WHERE id = ?', [run.id]),
    ).toEqual({
      status: 'failed',
      outputs: '[]',
    });
  });
});
