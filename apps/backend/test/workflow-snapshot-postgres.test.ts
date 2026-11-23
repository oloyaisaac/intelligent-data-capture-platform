import { Pool } from 'pg';
import { AuditRepository } from '../src/repositories/system-repo';
import { approveDocument, createHarness, registerAccount, SAMPLE_INVOICE_TEXT } from './helpers';

const pgTest = process.env.IDCP_TEST_DB_DRIVER === 'postgres' ? it : it.skip;

pgTest(
  'waits for a real PostgreSQL reprocess transaction before checking a workflow approval snapshot',
  async () => {
    const harness = await createHarness();
    const observer = new Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
    let release!: () => void;
    let reached!: () => void;
    const waiting = new Promise<void>((resolve) => {
      release = resolve;
    });
    const barrier = new Promise<void>((resolve) => {
      reached = resolve;
    });
    let reprocess: Promise<{ statusCode: number }> | undefined;
    let approve: Promise<{ statusCode: number }> | undefined;
    let spy: jest.SpyInstance | undefined;
    try {
      const account = await registerAccount(harness);
      harness.ocr.setText(SAMPLE_INVOICE_TEXT);
      const upload = await harness.api.upload(account.accessToken);
      const id = upload.json<{ id: string }>().id;
      await harness.services.worker.drain();
      await approveDocument(harness, account, id);
      const workflow = await harness.api.json('POST', '/api/v1/workflows', {
        token: account.accessToken,
        body: {
          name: 'Delete',
          trigger: 'document.approved',
          conditions: [],
          actions: [{ type: 'delete_document' }],
        },
      });
      expect(workflow.statusCode).toBe(201);
      const evaluation = await harness.api.json('POST', '/api/v1/workflows/evaluate', {
        token: account.accessToken,
        body: { trigger: 'document.approved', documentId: id },
      });
      const run = evaluation.json<{ runs: Array<{ id: string; status: string }> }>().runs[0]!;
      expect(run.status).toBe('awaiting_approval');
      const original = AuditRepository.prototype.record;
      spy = jest.spyOn(AuditRepository.prototype, 'record').mockImplementation(async function (
        this: AuditRepository,
        input,
      ) {
        await original.call(this, input);
        if (input.action === 'document.reprocessed' && input.targetId === id) {
          reached();
          await waiting;
        }
      });
      reprocess = harness.api.json('POST', `/api/v1/documents/${id}/reprocess`, {
        token: account.accessToken,
      });
      const timeout = new Promise<never>((_, reject) => {
        const timer = setTimeout(
          () => reject(new Error('Reprocessing did not reach transaction barrier')),
          10_000,
        );
        timer.unref();
      });
      await Promise.race([barrier, timeout]);
      approve = harness.api.json('POST', `/api/v1/workflows/runs/${run.id}/approve`, {
        token: account.accessToken,
      });
      let blocked = false;
      const deadline = Date.now() + 10_000;
      while (Date.now() < deadline && !blocked) {
        const result = await observer.query<{ waiting: boolean }>(
          `SELECT EXISTS (SELECT 1 FROM pg_stat_activity a
          WHERE a.wait_event_type = 'Lock' AND cardinality(pg_blocking_pids(a.pid)) > 0
            AND a.query LIKE 'SELECT * FROM documents WHERE organisation_id = %FOR UPDATE') AS waiting`,
        );
        blocked = result.rows[0]?.waiting ?? false;
        if (!blocked) await new Promise((resolve) => setTimeout(resolve, 25));
      }
      expect(blocked).toBe(true);
      release();
      expect((await reprocess).statusCode).toBe(202);
      expect((await approve).statusCode).toBe(409);
      expect(
        await harness.db.one('SELECT status, deleted_at FROM documents WHERE id = ?', [id]),
      ).toEqual({ status: 'queued', deleted_at: null });
      expect(
        await harness.db.one('SELECT status, outputs FROM workflow_runs WHERE id = ?', [run.id]),
      ).toEqual({ status: 'failed', outputs: '[]' });
    } finally {
      release();
      if (reprocess) await reprocess.catch(() => undefined);
      if (approve) await approve.catch(() => undefined);
      spy?.mockRestore();
      await observer.end();
      await harness.close();
    }
  },
  30_000,
);
