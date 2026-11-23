import { Pool } from 'pg';
import { AuditRepository } from '../src/repositories/system-repo';
import {
  approveDocument,
  createHarness,
  registerAccount,
  SAMPLE_INVOICE_TEXT,
  type Harness,
  type TestAccount,
} from './helpers';

const pgTest = process.env.IDCP_TEST_DB_DRIVER === 'postgres' ? it : it.skip;

async function pending(harness: Harness, owner: TestAccount) {
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
    },
  });
  expect(created.statusCode).toBe(201);
  const workflowId = created.json<{ id: string }>().id;
  const evaluation = await harness.api.json('POST', '/api/v1/workflows/evaluate', {
    token: owner.accessToken,
    body: { trigger: 'document.approved', documentId },
  });
  const run = evaluation.json<{ runs: Array<{ id: string; status: string }> }>().runs[0]!;
  expect(run.status).toBe('awaiting_approval');
  return { documentId, workflowId, runId: run.id };
}

async function waitForBlocked(observer: Pool, pattern: string) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const result = await observer.query<{ waiting: boolean }>(
      `SELECT EXISTS (SELECT 1 FROM pg_stat_activity a WHERE a.wait_event_type = 'Lock'
       AND cardinality(pg_blocking_pids(a.pid)) > 0 AND a.query LIKE $1) AS waiting`,
      [pattern],
    );
    if (result.rows[0]?.waiting) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('PostgreSQL did not show the expected lock wait');
}

pgTest(
  'a committed disable wins when approval is waiting on its PostgreSQL row lock',
  async () => {
    const harness = await createHarness();
    const observer = new Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
    let release!: () => void;
    let reached!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const barrier = new Promise<void>((resolve) => {
      reached = resolve;
    });
    let disabling: Promise<void> | undefined;
    let approving: Promise<{ statusCode: number }> | undefined;
    try {
      const owner = await registerAccount(harness);
      const { documentId, workflowId, runId } = await pending(harness, owner);
      disabling = harness.db.transaction(async (tx) => {
        await tx.execute('UPDATE workflows SET enabled = 0 WHERE organisation_id = ? AND id = ?', [
          owner.organisationId,
          workflowId,
        ]);
        reached();
        await gate;
      });
      await barrier;
      approving = harness.api.json('POST', `/api/v1/workflows/runs/${runId}/approve`, {
        token: owner.accessToken,
      });
      await waitForBlocked(observer, 'SELECT * FROM workflows WHERE organisation_id = %FOR UPDATE');
      release();
      await disabling;
      expect((await approving).statusCode).toBe(409);
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
      release();
      await disabling?.catch(() => undefined);
      await approving?.catch(() => undefined);
      await observer.end();
      await harness.close();
    }
  },
  30_000,
);

pgTest(
  'disable waits when approval already holds the PostgreSQL workflow lock',
  async () => {
    const harness = await createHarness();
    const observer = new Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
    let release!: () => void;
    let reached!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const barrier = new Promise<void>((resolve) => {
      reached = resolve;
    });
    let approving: Promise<{ statusCode: number }> | undefined;
    let disabling: Promise<{ statusCode: number }> | undefined;
    let spy: jest.SpyInstance | undefined;
    try {
      const owner = await registerAccount(harness);
      const { documentId, workflowId, runId } = await pending(harness, owner);
      const original = AuditRepository.prototype.record;
      spy = jest.spyOn(AuditRepository.prototype, 'record').mockImplementation(async function (
        this: AuditRepository,
        input,
      ) {
        await original.call(this, input);
        if (input.action === 'document.deleted' && input.targetId === documentId) {
          reached();
          await gate;
        }
      });
      approving = harness.api.json('POST', `/api/v1/workflows/runs/${runId}/approve`, {
        token: owner.accessToken,
      });
      await barrier;
      disabling = harness.api.json('PATCH', `/api/v1/workflows/${workflowId}`, {
        token: owner.accessToken,
        body: { enabled: false },
      });
      await waitForBlocked(observer, 'UPDATE workflows SET enabled = %');
      release();
      expect((await approving).statusCode).toBe(200);
      expect((await disabling).statusCode).toBe(200);
      const row = await harness.db.one<{ deleted_at: string | null }>(
        'SELECT deleted_at FROM documents WHERE id = ?',
        [documentId],
      );
      expect(row?.deleted_at).not.toBeNull();
      expect(
        await harness.db.one('SELECT status FROM workflow_runs WHERE id = ?', [runId]),
      ).toEqual({ status: 'completed' });
    } finally {
      release();
      await approving?.catch(() => undefined);
      await disabling?.catch(() => undefined);
      spy?.mockRestore();
      await observer.end();
      await harness.close();
    }
  },
  30_000,
);
