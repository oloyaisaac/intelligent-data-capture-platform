import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Pool } from 'pg';
import type { Database } from '../src/db/database';
import { AuditRepository, JobsRepository } from '../src/repositories/system-repo';
import { WorkerRecoveryRepository } from '../src/repositories/worker-recovery-repo';
import { WorkflowRunsRepository } from '../src/repositories/workflow-repo';
import {
  createHarness,
  openReview,
  registerAccount,
  uploadDocument,
  type ApiResponse,
  type Harness,
} from './helpers';

const postgresEnabled = process.env.IDCP_TEST_DB_DRIVER === 'postgres';
const postgresDescribe = postgresEnabled ? describe : describe.skip;

/**
 * MC-04 — executed only in the PostgreSQL CI job. The ordinary local suite remains fast and
 * self-contained on SQLite; CI opts in with IDCP_TEST_DB_DRIVER=postgres and a service DATABASE_URL.
 */
postgresDescribe('PostgreSQL production-driver smoke test (MC-04)', () => {
  let harness: Harness;

  beforeAll(async () => {
    harness = await createHarness();
  });

  afterAll(async () => {
    await harness?.close();
  });

  it('rolls back recovery on audit failure and commits only one concurrent recovery', async () => {
    const account = await registerAccount(harness);
    const jobs = new JobsRepository(harness.db);
    const job = await jobs.enqueue({
      organisationId: account.organisationId,
      type: 'retention_purge',
    });
    await harness.db.execute("UPDATE jobs SET status = 'running', attempts = 1 WHERE id = ?", [
      job.id,
    ]);
    const input = {
      id: job.id,
      attempt: 1,
      operatorReference: 'operator-1',
      incidentReference: 'INC-42',
    };
    const failing = {
      transaction: <T>(run: (db: Database) => Promise<T>) =>
        harness.db.transaction((tx) =>
          run({
            ...tx,
            execute: async (sql, params) => {
              if (sql.includes('INSERT INTO audit_logs'))
                throw new Error('synthetic audit failure');
              return tx.execute(sql, params);
            },
          }),
        ),
    } as Database;
    try {
      await expect(new WorkerRecoveryRepository(failing).requeueWithAudit(input)).rejects.toThrow(
        'synthetic audit failure',
      );
      expect((await jobs.findById(job.id))?.status).toBe('running');
      const recovery = new WorkerRecoveryRepository(harness.db);
      const results = await Promise.all([
        recovery.requeueWithAudit(input),
        recovery.requeueWithAudit(input),
      ]);
      expect(results.filter(Boolean)).toHaveLength(1);
      expect((await jobs.findById(job.id))?.status).toBe('queued');
      expect(
        await harness.db.query('SELECT id FROM audit_logs WHERE action = ? AND target_id = ?', [
          'worker.job_requeued_offline',
          job.id,
        ]),
      ).toHaveLength(1);
    } finally {
      await harness.db.execute('DELETE FROM jobs WHERE id = ?', [job.id]);
    }
  }, 30_000);

  it('rolls back document deletion when auditing fails and audits only one concurrent delete', async () => {
    const account = await registerAccount(harness);
    const upload = await uploadDocument(harness, account);
    const id = upload.json<{ id: string }>().id;
    const original = AuditRepository.prototype.record;
    const audit = jest
      .spyOn(AuditRepository.prototype, 'record')
      .mockImplementation(async function (this: AuditRepository, input) {
        if (input.action === 'document.deleted') throw new Error('synthetic audit failure');
        await original.call(this, input);
      });
    try {
      const failed = await harness.api.json('DELETE', `/api/v1/documents/${id}`, {
        token: account.accessToken,
      });
      expect(failed.statusCode).toBe(500);
      expect(
        await harness.db.one('SELECT status, deleted_at FROM documents WHERE id = ?', [id]),
      ).toEqual({ status: 'queued', deleted_at: null });
    } finally {
      audit.mockRestore();
    }
    const remove = () =>
      harness.api.json('DELETE', `/api/v1/documents/${id}`, { token: account.accessToken });
    const responses = await Promise.all([remove(), remove()]);
    expect(responses.map((response) => response.statusCode).sort()).toEqual([204, 404]);
    expect(
      await harness.db.query('SELECT id FROM audit_logs WHERE action = ? AND target_id = ?', [
        'document.deleted',
        id,
      ]),
    ).toHaveLength(1);
    await harness.db.execute('DELETE FROM jobs WHERE document_id = ?', [id]);
  }, 30_000);

  it('serializes workflow approvals behind the PostgreSQL run lock', async () => {
    const account = await registerAccount(harness);
    const upload = await uploadDocument(harness, account);
    const documentId = upload.json<{ id: string }>().id;
    const workflow = await harness.api.json('POST', '/api/v1/workflows', {
      token: account.accessToken,
      body: {
        name: 'Approve delete',
        trigger: 'document.extracted',
        conditions: [],
        actions: [{ type: 'delete_document' }],
      },
    });
    expect(workflow.statusCode).toBe(201);
    const evaluation = await harness.api.json('POST', '/api/v1/workflows/evaluate', {
      token: account.accessToken,
      body: { trigger: 'document.extracted', documentId },
    });
    const runId = evaluation.json<{ runs: Array<{ id: string; status: string }> }>().runs[0]!.id;
    const observer = new Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
    let approvals: Promise<ApiResponse[]> | undefined;
    try {
      await harness.db.transaction(async (tx) => {
        await tx.one('SELECT id FROM workflow_runs WHERE id = ? FOR UPDATE', [runId]);
        const locker = await tx.one<{ pid: number }>('SELECT pg_backend_pid() AS pid');
        if (!locker) throw new Error('Could not identify locking session');
        const approve = () =>
          harness.api.json('POST', `/api/v1/workflows/runs/${runId}/approve`, {
            token: account.accessToken,
          });
        approvals = Promise.all([approve(), approve()]);
        void approvals.catch(() => undefined);
        const deadline = Date.now() + 10_000;
        let blocked = 0;
        while (Date.now() < deadline && blocked < 2) {
          const result = await observer.query<{ count: number }>(
            `WITH RECURSIVE blocked(pid) AS (
               SELECT $1::int UNION
               SELECT activity.pid FROM pg_stat_activity activity JOIN blocked
                 ON blocked.pid = ANY(pg_blocking_pids(activity.pid))
             ) SELECT COUNT(*)::int AS count FROM pg_stat_activity activity JOIN blocked ON blocked.pid = activity.pid
               WHERE activity.pid <> $1 AND activity.wait_event_type = 'Lock'
                 AND activity.query LIKE 'SELECT * FROM workflow_runs WHERE organisation_id = %'`,
            [locker.pid],
          );
          blocked = result.rows[0]?.count ?? 0;
          if (blocked < 2) await new Promise((resolve) => setTimeout(resolve, 25));
        }
        expect(blocked).toBe(2);
      });
      const responses = await approvals!;
      expect(responses.map((response) => response.statusCode).sort()).toEqual([200, 409]);
      expect(
        await harness.db.one('SELECT status FROM workflow_runs WHERE id = ?', [runId]),
      ).toEqual({ status: 'completed' });
      expect(
        await harness.db.query('SELECT id FROM audit_logs WHERE action = ? AND target_id = ?', [
          'document.deleted',
          documentId,
        ]),
      ).toHaveLength(1);
      expect(
        await harness.db.query('SELECT id FROM audit_logs WHERE action = ? AND target_id = ?', [
          'workflow.run_approved',
          workflow.json<{ id: string }>().id,
        ]),
      ).toHaveLength(1);
      await harness.db.execute('DELETE FROM jobs WHERE document_id = ?', [documentId]);
    } finally {
      await observer.end();
      if (approvals) await approvals.catch(() => undefined);
    }
  }, 30_000);

  it('serializes interrupted cancellation against the original workflow execution', async () => {
    const account = await registerAccount(harness);
    const upload = await uploadDocument(harness, account);
    const documentId = upload.json<{ id: string }>().id;
    const workflow = await harness.api.json('POST', '/api/v1/workflows', {
      token: account.accessToken,
      body: {
        name: 'Auto delete',
        trigger: 'document.extracted',
        conditions: [],
        approvalPolicy: 'auto_approve',
        actions: [{ type: 'delete_document' }],
      },
    });
    expect(workflow.statusCode).toBe(201);
    let release!: () => void;
    let created!: (id: string) => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const ready = new Promise<string>((resolve) => {
      created = resolve;
    });
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
      body: { trigger: 'document.extracted', documentId },
    });
    const observer = new Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
    let cancellation: Promise<ApiResponse> | undefined;
    try {
      const runId = await ready;
      await harness.db.transaction(async (tx) => {
        await tx.one('SELECT id FROM workflow_runs WHERE id = ? FOR UPDATE', [runId]);
        const locker = await tx.one<{ pid: number }>('SELECT pg_backend_pid() AS pid');
        if (!locker) throw new Error('Could not identify locking session');
        cancellation = harness.api.json(
          'POST',
          `/api/v1/workflows/runs/${runId}/cancel-interrupted`,
          {
            token: account.accessToken,
            body: { confirmReviewed: true, incidentReference: 'INC-99' },
          },
        );
        void cancellation.catch(() => undefined);
        release();
        const deadline = Date.now() + 10_000;
        let blocked = 0;
        while (Date.now() < deadline && blocked < 2) {
          const result = await observer.query<{ count: number }>(
            `WITH RECURSIVE blocked(pid) AS (
               SELECT $1::int UNION
               SELECT activity.pid FROM pg_stat_activity activity JOIN blocked
                 ON blocked.pid = ANY(pg_blocking_pids(activity.pid))
             ) SELECT COUNT(*)::int AS count FROM pg_stat_activity activity JOIN blocked ON blocked.pid = activity.pid
               WHERE activity.pid <> $1 AND activity.wait_event_type = 'Lock'
                 AND activity.query LIKE 'SELECT * FROM workflow_runs WHERE organisation_id = %'`,
            [locker.pid],
          );
          blocked = result.rows[0]?.count ?? 0;
          if (blocked < 2) await new Promise((resolve) => setTimeout(resolve, 25));
        }
        expect(blocked).toBe(2);
      });
      const [evaluated, cancelled] = await Promise.all([evaluation, cancellation!]);
      const row = await harness.db.one<{ status: string }>(
        'SELECT status FROM workflow_runs WHERE id = ?',
        [runId],
      );
      const document = await harness.db.one<{ deleted_at: string | null }>(
        'SELECT deleted_at FROM documents WHERE id = ?',
        [documentId],
      );
      const cancellationAudits = await harness.db.query(
        'SELECT id FROM audit_logs WHERE action = ? AND target_id = ?',
        ['workflow.run_cancelled_interrupted', workflow.json<{ id: string }>().id],
      );
      const deletionAudits = await harness.db.query(
        'SELECT id FROM audit_logs WHERE action = ? AND target_id = ?',
        ['document.deleted', documentId],
      );
      if (cancelled.statusCode === 200) {
        expect(evaluated.statusCode).toBe(500);
        expect(row?.status).toBe('failed');
        expect(document?.deleted_at).toBeNull();
        expect(cancellationAudits).toHaveLength(1);
        expect(deletionAudits).toHaveLength(0);
      } else {
        expect(cancelled.statusCode).toBe(409);
        expect(evaluated.statusCode).toBe(200);
        expect(row?.status).toBe('completed');
        expect(document?.deleted_at).not.toBeNull();
        expect(cancellationAudits).toHaveLength(0);
        expect(deletionAudits).toHaveLength(1);
      }
      await harness.db.execute('DELETE FROM jobs WHERE document_id = ?', [documentId]);
    } finally {
      release();
      spy.mockRestore();
      await observer.end();
      await evaluation.catch(() => undefined);
      if (cancellation) await cancellation.catch(() => undefined);
    }
  }, 30_000);

  it('skips a locked job and claims it once after the lock is released', async () => {
    const jobs = new JobsRepository(harness.db);
    const job = await jobs.enqueue({ organisationId: randomUUID(), type: 'test-concurrent-claim' });
    await harness.db.transaction(async (tx) => {
      await tx.one('SELECT id FROM jobs WHERE id = ? FOR UPDATE', [job.id]);
      expect(await Promise.all([jobs.claimNext(), jobs.claimNext()])).toEqual([null, null]);
    });
    const results = await Promise.all([jobs.claimNext(), jobs.claimNext()]);
    expect(results.filter((row) => row !== null)).toHaveLength(1);
    expect(results.find((row) => row !== null)?.id).toBe(job.id);
    expect((await jobs.findById(job.id))?.attempts).toBe(1);
  }, 30_000);

  it('serializes distinct extraction claims on the same document', async () => {
    const account = await registerAccount(harness);
    const upload = await uploadDocument(harness, account);
    const documentId = upload.json<{ id: string }>().id;
    const jobs = new JobsRepository(harness.db);
    const first = (await jobs.listForDocument(documentId))[0]!;
    const second = await jobs.enqueue({
      organisationId: account.organisationId,
      type: 'extract_document',
      documentId,
    });
    const observer = new Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
    let claims: Promise<Awaited<ReturnType<JobsRepository['claimNext']>>[]> | undefined;
    try {
      await harness.db.transaction(async (tx) => {
        await tx.one('SELECT id FROM documents WHERE id = ? FOR UPDATE', [documentId]);
        const locker = await tx.one<{ pid: number }>('SELECT pg_backend_pid() AS pid');
        if (!locker) throw new Error('Could not identify document-locking session');
        claims = Promise.all([jobs.claimNext(), jobs.claimNext()]);
        void claims.catch(() => undefined);
        const deadline = Date.now() + 10_000;
        let blocked = 0;
        while (Date.now() < deadline && blocked < 2) {
          const result = await observer.query<{ count: number }>(
            `WITH RECURSIVE blocked(pid) AS (
               SELECT $1::int
               UNION
               SELECT activity.pid FROM pg_stat_activity activity
                 JOIN blocked ON blocked.pid = ANY(pg_blocking_pids(activity.pid))
             )
             SELECT COUNT(*)::int AS count FROM pg_stat_activity activity
               JOIN blocked ON blocked.pid = activity.pid
             WHERE activity.pid <> $1 AND activity.wait_event_type = 'Lock'
               AND activity.query LIKE 'SELECT id FROM documents WHERE organisation_id = %'`,
            [locker.pid],
          );
          blocked = result.rows[0]?.count ?? 0;
          if (blocked < 2) await new Promise((resolve) => setTimeout(resolve, 25));
        }
        expect(blocked).toBe(2);
      });
      const results = await claims!;
      expect(results.filter((row) => row !== null)).toHaveLength(1);
      const rows = [await jobs.findById(first.id), await jobs.findById(second.id)];
      expect(rows.filter((row) => row?.status === 'running')).toHaveLength(1);
      expect(rows.filter((row) => row?.status === 'queued' && row.attempts === 0)).toHaveLength(1);
      // Leave no active extraction to interfere with later tests sharing this schema.
      const running = rows.find((row) => row?.status === 'running')!;
      await jobs.markSucceeded(running.id, running.attempts);
      await harness.db.execute('DELETE FROM jobs WHERE id = ?', [
        second.id === running.id ? first.id : second.id,
      ]);
    } finally {
      await observer.end();
      if (claims) await claims.catch(() => undefined);
    }
  }, 30_000);

  it('serializes distinct retention job claims on the organisation row', async () => {
    const account = await registerAccount(harness);
    const jobs = new JobsRepository(harness.db);
    const first = await jobs.enqueue({
      organisationId: account.organisationId,
      type: 'retention_purge',
    });
    const second = await jobs.enqueue({
      organisationId: account.organisationId,
      type: 'retention_purge',
    });
    const observer = new Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
    let claims: Promise<Awaited<ReturnType<JobsRepository['claimNext']>>[]> | undefined;
    try {
      await harness.db.transaction(async (tx) => {
        await tx.one('SELECT id FROM organisations WHERE id = ? FOR UPDATE', [
          account.organisationId,
        ]);
        const locker = await tx.one<{ pid: number }>('SELECT pg_backend_pid() AS pid');
        if (!locker) throw new Error('Could not identify organisation-locking session');
        claims = Promise.all([jobs.claimNext(), jobs.claimNext()]);
        void claims.catch(() => undefined);
        const deadline = Date.now() + 10_000;
        let blocked = 0;
        while (Date.now() < deadline && blocked < 2) {
          const result = await observer.query<{ count: number }>(
            `WITH RECURSIVE blocked(pid) AS (
               SELECT $1::int UNION
               SELECT activity.pid FROM pg_stat_activity activity JOIN blocked
                 ON blocked.pid = ANY(pg_blocking_pids(activity.pid))
             ) SELECT COUNT(*)::int AS count FROM pg_stat_activity activity JOIN blocked ON blocked.pid = activity.pid
               WHERE activity.pid <> $1 AND activity.wait_event_type = 'Lock'
                 AND activity.query LIKE 'SELECT id FROM organisations WHERE id = %'`,
            [locker.pid],
          );
          blocked = result.rows[0]?.count ?? 0;
          if (blocked < 2) await new Promise((resolve) => setTimeout(resolve, 25));
        }
        expect(blocked).toBe(2);
      });
      const results = await claims!;
      expect(results.filter((row) => row !== null)).toHaveLength(1);
      const rows = [await jobs.findById(first.id), await jobs.findById(second.id)];
      expect(rows.filter((row) => row?.status === 'running')).toHaveLength(1);
      expect(rows.filter((row) => row?.status === 'queued' && row.attempts === 0)).toHaveLength(1);
      await harness.db.execute('DELETE FROM jobs WHERE id IN (?, ?)', [first.id, second.id]);
    } finally {
      await observer.end();
      if (claims) await claims.catch(() => undefined);
    }
  }, 30_000);

  it('serializes competing retention scheduling requests on PostgreSQL', async () => {
    const account = await registerAccount(harness);
    const jobs = new JobsRepository(harness.db);
    const observer = new Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
    let requests:
      Promise<Awaited<ReturnType<JobsRepository['enqueueRetentionIfAbsent']>>[]> | undefined;
    try {
      await harness.db.transaction(async (tx) => {
        await tx.one('SELECT id FROM organisations WHERE id = ? FOR UPDATE', [
          account.organisationId,
        ]);
        const locker = await tx.one<{ pid: number }>('SELECT pg_backend_pid() AS pid');
        if (!locker) throw new Error('Could not identify organisation-locking session');
        requests = Promise.all([
          jobs.enqueueRetentionIfAbsent({ organisationId: account.organisationId }),
          jobs.enqueueRetentionIfAbsent({
            organisationId: account.organisationId,
            onlyEnabled: true,
          }),
        ]);
        void requests.catch(() => undefined);
        const deadline = Date.now() + 10_000;
        let blocked = 0;
        while (Date.now() < deadline && blocked < 2) {
          const result = await observer.query<{ count: number }>(
            `WITH RECURSIVE blocked(pid) AS (
               SELECT $1::int UNION
               SELECT activity.pid FROM pg_stat_activity activity JOIN blocked
                 ON blocked.pid = ANY(pg_blocking_pids(activity.pid))
             ) SELECT COUNT(*)::int AS count FROM pg_stat_activity activity JOIN blocked ON blocked.pid = activity.pid
               WHERE activity.pid <> $1 AND activity.wait_event_type = 'Lock'
                 AND activity.query LIKE 'SELECT retention_days FROM organisations WHERE id = %'`,
            [locker.pid],
          );
          blocked = result.rows[0]?.count ?? 0;
          if (blocked < 2) await new Promise((resolve) => setTimeout(resolve, 25));
        }
        expect(blocked).toBe(2);
      });
      const results = await requests!;
      expect(results.filter((row) => row.created)).toHaveLength(1);
      expect(results[0]?.job?.id).toBe(results[1]?.job?.id);
      expect(
        await harness.db.query(
          "SELECT id FROM jobs WHERE organisation_id = ? AND type = 'retention_purge'",
          [account.organisationId],
        ),
      ).toHaveLength(1);
      await harness.db.execute('DELETE FROM jobs WHERE organisation_id = ? AND type = ?', [
        account.organisationId,
        'retention_purge',
      ]);
    } finally {
      await observer.end();
      if (requests) await requests.catch(() => undefined);
    }
  }, 30_000);

  it('rechecks review eligibility after waiting on a document locked by reprocessing', async () => {
    const account = await registerAccount(harness);
    const upload = await uploadDocument(harness, account);
    const documentId = upload.json<{ id: string }>().id;
    await harness.services.worker.drain();
    const review = await openReview(harness, account, documentId);
    const observer = new Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
    let rejection: Promise<ApiResponse> | undefined;
    try {
      await harness.db.transaction(async (tx) => {
        await tx.one('SELECT id FROM documents WHERE id = ? FOR UPDATE', [documentId]);
        const locker = await tx.one<{ pid: number }>('SELECT pg_backend_pid() AS pid');
        if (!locker) throw new Error('Could not identify document-locking session');
        rejection = harness.api.json('POST', `/api/v1/review/${review.reviewId}/reject`, {
          token: account.accessToken,
          body: { reason: 'stale decision' },
        });
        void rejection.catch(() => undefined);
        const deadline = Date.now() + 10_000;
        let blocked = 0;
        while (Date.now() < deadline && blocked < 1) {
          const result = await observer.query<{ count: number }>(
            `SELECT COUNT(*)::int AS count FROM pg_stat_activity activity
             WHERE $1::int = ANY(pg_blocking_pids(activity.pid))
               AND activity.wait_event_type = 'Lock'
               AND activity.query LIKE 'SELECT * FROM documents WHERE organisation_id = %'`,
            [locker.pid],
          );
          blocked = result.rows[0]?.count ?? 0;
          if (!blocked) await new Promise((resolve) => setTimeout(resolve, 25));
        }
        expect(blocked).toBe(1);
        // Emulate the durable changes of reprocess while holding the same document lock.
        await tx.execute("UPDATE reviews SET status = 'superseded' WHERE id = ?", [
          review.reviewId,
        ]);
        await tx.execute("UPDATE documents SET status = 'queued' WHERE id = ?", [documentId]);
      });
      expect((await rejection!).statusCode).toBe(409);
      expect(
        await harness.db.one('SELECT status FROM documents WHERE id = ?', [documentId]),
      ).toEqual({ status: 'queued' });
      expect(
        await harness.db.one('SELECT status FROM reviews WHERE id = ?', [review.reviewId]),
      ).toEqual({ status: 'superseded' });
    } finally {
      await observer.end();
      if (rejection) await rejection.catch(() => undefined);
    }
  }, 30_000);

  it('rechecks expiration after waiting for the pairing row lock', async () => {
    const account = await registerAccount(harness);
    const created = await harness.api.json('POST', '/api/v1/pairing/sessions', {
      token: account.accessToken,
    });
    expect(created.statusCode).toBe(201);
    const session = created.json<{ id: string; token: string }>();
    const observer = new Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
    let completion: Promise<ApiResponse> | undefined;
    try {
      await harness.db.transaction(async (tx) => {
        await tx.one('SELECT id FROM pairing_sessions WHERE id = ? FOR UPDATE', [session.id]);
        const locker = await tx.one<{ pid: number }>('SELECT pg_backend_pid() AS pid');
        if (!locker) throw new Error('Could not identify the row-locking session');
        completion = harness.api.json('POST', '/api/v1/pairing/complete', {
          body: { token: session.token, device: { name: 'Blocked phone', platform: 'android' } },
        });
        void completion.catch(() => undefined);
        const deadline = Date.now() + 10_000;
        let blocked = 0;
        while (Date.now() < deadline && blocked < 1) {
          const result = await observer.query<{ count: number }>(
            `SELECT COUNT(*)::int AS count FROM pg_stat_activity activity
              WHERE $1::int = ANY(pg_blocking_pids(activity.pid))
                AND activity.wait_event_type = 'Lock'
                AND activity.query LIKE 'SELECT * FROM pairing_sessions WHERE token_hash = %'`,
            [locker.pid],
          );
          blocked = result.rows[0]?.count ?? 0;
          if (blocked < 1) await new Promise((resolve) => setTimeout(resolve, 25));
        }
        expect(blocked).toBeGreaterThanOrEqual(1);
        await tx.execute('UPDATE pairing_sessions SET expires_at = ? WHERE id = ?', [
          new Date(Date.now() - 1000).toISOString(),
          session.id,
        ]);
      });
      const result = await completion!;
      expect(result.statusCode).toBe(422);
      expect(result.json()).toMatchObject({ error: { code: 'PAIRING_TOKEN_EXPIRED' } });
      const count = await harness.db.one<{ count: number }>(
        'SELECT COUNT(*) AS count FROM devices WHERE organisation_id = ?',
        [account.organisationId],
      );
      expect(Number(count?.count)).toBe(0);
    } finally {
      await observer.end();
      if (completion) await completion.catch(() => undefined);
    }
  }, 30_000);

  it('rechecks export expiry after waiting for a PostgreSQL row lock', async () => {
    const isolated = await createHarness();
    const observer = new Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
    let sweep:
      Promise<Awaited<ReturnType<typeof isolated.services.maintenance.runOnce>>> | undefined;
    try {
      const account = await registerAccount(isolated);
      const key = `org/${account.organisationId}/exports/locked.csv`;
      await isolated.storage.put(key, Buffer.from('synthetic'));
      await isolated.db.execute(
        `INSERT INTO exports (id, organisation_id, requested_by, format, filter, storage_key, status, expires_at, created_at)
         VALUES (?, ?, ?, 'csv', '{}', ?, 'ready', ?, ?)`,
        [
          'locked-export',
          account.organisationId,
          account.userId,
          key,
          '2000-01-01T00:00:00.000Z',
          '2000-01-01T00:00:00.000Z',
        ],
      );
      await isolated.db.transaction(async (tx) => {
        await tx.one('SELECT id FROM exports WHERE id = ? FOR UPDATE', ['locked-export']);
        const locker = await tx.one<{ pid: number }>('SELECT pg_backend_pid() AS pid');
        if (!locker) throw new Error('Could not identify locking session');
        sweep = isolated.services.maintenance.runOnce(new Date('2026-01-01T00:00:00.000Z'));
        void sweep.catch(() => undefined);
        const deadline = Date.now() + 10_000;
        let blocked = 0;
        while (Date.now() < deadline && blocked < 1) {
          const result = await observer.query<{ count: number }>(
            `SELECT COUNT(*)::int AS count FROM pg_stat_activity activity
             WHERE $1::int = ANY(pg_blocking_pids(activity.pid)) AND activity.wait_event_type = 'Lock'
               AND activity.query LIKE 'SELECT id, storage_key, status, expires_at FROM exports WHERE id = %'`,
            [locker.pid],
          );
          blocked = result.rows[0]?.count ?? 0;
          if (blocked < 1) await new Promise((resolve) => setTimeout(resolve, 25));
        }
        expect(blocked).toBe(1);
        await tx.execute('UPDATE exports SET expires_at = ? WHERE id = ?', [
          '2999-01-01T00:00:00.000Z',
          'locked-export',
        ]);
      });
      expect((await sweep!).exportsExpired).toBe(0);
      expect(await isolated.storage.exists(key)).toBe(true);
      expect(
        await isolated.db.one('SELECT status, storage_key, expires_at FROM exports WHERE id = ?', [
          'locked-export',
        ]),
      ).toEqual({
        status: 'ready',
        storage_key: key,
        expires_at: '2999-01-01T00:00:00.000Z',
      });
    } finally {
      if (sweep) await sweep.catch(() => undefined);
      await observer.end();
      await isolated.close();
    }
  }, 30_000);

  it('rechecks a retention candidate after waiting for a PostgreSQL document lock', async () => {
    const isolated = await createHarness();
    const observer = new Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
    let purge: Promise<number> | undefined;
    try {
      const account = await registerAccount(isolated);
      const upload = await isolated.api.upload(account.accessToken);
      const documentId = upload.json<{ id: string }>().id;
      await isolated.services.worker.drain();
      await isolated.db.execute('UPDATE documents SET created_at = ? WHERE id = ?', [
        '2000-01-01T00:00:00.000Z',
        documentId,
      ]);
      const document = await isolated.db.one<{ storage_key: string }>(
        'SELECT storage_key FROM documents WHERE id = ?',
        [documentId],
      );
      await isolated.db.transaction(async (tx) => {
        await tx.one('SELECT id FROM documents WHERE id = ? FOR UPDATE', [documentId]);
        const locker = await tx.one<{ pid: number }>('SELECT pg_backend_pid() AS pid');
        if (!locker) throw new Error('Could not identify locking session');
        purge = isolated.services.documents.purgeExpired(account.organisationId, 90);
        void purge.catch(() => undefined);
        const deadline = Date.now() + 10_000;
        let blocked = 0;
        while (Date.now() < deadline && blocked < 1) {
          const result = await observer.query<{ count: number }>(
            `SELECT COUNT(*)::int AS count FROM pg_stat_activity activity
             WHERE $1::int = ANY(pg_blocking_pids(activity.pid)) AND activity.wait_event_type = 'Lock'
               AND activity.query LIKE 'SELECT * FROM documents WHERE organisation_id = %'`,
            [locker.pid],
          );
          blocked = result.rows[0]?.count ?? 0;
          if (blocked < 1) await new Promise((resolve) => setTimeout(resolve, 25));
        }
        expect(blocked).toBe(1);
        await new JobsRepository(tx).enqueue({
          organisationId: account.organisationId,
          documentId,
          type: 'extract_document',
        });
      });
      await expect(purge!).rejects.toThrow('Retention purge incomplete');
      expect(await isolated.storage.exists(document!.storage_key)).toBe(true);
      expect(
        await isolated.db.one('SELECT deleted_at FROM documents WHERE id = ?', [documentId]),
      ).toEqual({ deleted_at: null });
      expect(
        await isolated.db.query('SELECT id FROM audit_logs WHERE action = ? AND target_id = ?', [
          'retention.purged',
          documentId,
        ]),
      ).toHaveLength(0);
    } finally {
      if (purge) await purge.catch(() => undefined);
      await observer.end();
      await isolated.close();
    }
  }, 30_000);

  it('rechecks retention policy after waiting for the PostgreSQL organisation lock', async () => {
    const isolated = await createHarness();
    const observer = new Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
    let purge: Promise<number> | undefined;
    try {
      const account = await registerAccount(isolated);
      const upload = await isolated.api.upload(account.accessToken);
      const documentId = upload.json<{ id: string }>().id;
      await isolated.services.worker.drain();
      await isolated.db.execute('UPDATE documents SET created_at = ? WHERE id = ?', [
        '2000-01-01T00:00:00.000Z',
        documentId,
      ]);
      const document = await isolated.db.one<{ storage_key: string }>(
        'SELECT storage_key FROM documents WHERE id = ?',
        [documentId],
      );
      await isolated.db.transaction(async (tx) => {
        await tx.one('SELECT id FROM organisations WHERE id = ? FOR UPDATE', [
          account.organisationId,
        ]);
        const locker = await tx.one<{ pid: number }>('SELECT pg_backend_pid() AS pid');
        if (!locker) throw new Error('Could not identify locking session');
        purge = isolated.services.documents.purgeExpired(account.organisationId, 90);
        void purge.catch(() => undefined);
        const deadline = Date.now() + 10_000;
        let blocked = 0;
        while (Date.now() < deadline && blocked < 1) {
          const result = await observer.query<{ count: number }>(
            `SELECT COUNT(*)::int AS count FROM pg_stat_activity activity
             WHERE $1::int = ANY(pg_blocking_pids(activity.pid)) AND activity.wait_event_type = 'Lock'
               AND activity.query LIKE 'SELECT retention_days FROM organisations WHERE id = %'`,
            [locker.pid],
          );
          blocked = result.rows[0]?.count ?? 0;
          if (blocked < 1) await new Promise((resolve) => setTimeout(resolve, 25));
        }
        expect(blocked).toBe(1);
        await tx.execute('UPDATE organisations SET retention_days = 0 WHERE id = ?', [
          account.organisationId,
        ]);
      });
      await expect(purge!).rejects.toThrow('Retention purge incomplete');
      expect(await isolated.storage.exists(document!.storage_key)).toBe(true);
      expect(
        await isolated.db.one('SELECT deleted_at FROM documents WHERE id = ?', [documentId]),
      ).toEqual({ deleted_at: null });
      expect(
        await isolated.db.query('SELECT id FROM audit_logs WHERE action = ? AND target_id = ?', [
          'retention.purged',
          documentId,
        ]),
      ).toHaveLength(0);
    } finally {
      if (purge) await purge.catch(() => undefined);
      await observer.end();
      await isolated.close();
    }
  }, 30_000);

  it('preserves question marks in a document extraction JSON parameter', async () => {
    const account = await registerAccount(harness);
    const upload = await uploadDocument(harness, account);
    expect(upload.statusCode).toBe(201);
    const documentId = upload.json<{ id: string }>().id;
    const extractionId = randomUUID();
    const json = JSON.stringify({ question: 'How much?', nested: ['?', 'literal $1 ?'] });
    await harness.db.execute(
      `INSERT INTO extractions (id, document_id, organisation_id, attempt, udm, udm_version, provider, confidence, needs_review, cost_micros, created_at)
       VALUES (?, ?, ?, 1, ?, 'test', 'fixture', 1, 1, 0, ?)`,
      [extractionId, documentId, account.organisationId, json, new Date().toISOString()],
    );
    const row = await harness.db.one<{ udm: string; literal_question: string }>(
      "SELECT udm, '?' AS literal_question FROM extractions WHERE id = ? AND document_id = ?",
      [extractionId, documentId],
    );
    expect(row).toEqual({ udm: json, literal_question: '?' });
  });

  it('paginates the read-only worker recovery inventory CLI against PostgreSQL', async () => {
    const isolated = await createHarness();
    try {
      await isolated.db.execute(
        `INSERT INTO jobs (id, organisation_id, type, status, attempts, payload, last_error, created_at)
         SELECT 'job-' || lpad(n::text, 4, '0'), 'org', 'retention_purge', 'running', 1,
                'synthetic-secret-payload', 'synthetic-secret-error', '2000-01-01T00:00:00.000Z'
         FROM generate_series(0, 1001) n`,
      );
      const schema = await isolated.db.one<{ schema: string }>('SELECT current_schema() AS schema');
      const url = new URL(process.env.DATABASE_URL!);
      url.searchParams.set('options', `-c search_path=${schema!.schema}`);
      const cli = (...args: string[]) =>
        spawnSync(process.execPath, ['--import', 'tsx', 'src/db/worker-recovery-cli.ts', ...args], {
          cwd: resolve(__dirname, '..'),
          env: {
            PATH: process.env.PATH,
            NODE_ENV: 'test',
            DB_DRIVER: 'postgres',
            DATABASE_URL: url.toString(),
          },
          encoding: 'utf8',
        });
      const first = cli('--list', '--confirm-offline');
      expect(first.status).toBe(0);
      expect(first.stdout).not.toContain('synthetic-secret');
      const page = JSON.parse(first.stdout) as {
        count: number;
        jobs: Array<{ id: string }>;
        truncated: boolean;
        nextAfter: string | null;
      };
      expect(page.count).toBe(1002);
      expect(page.jobs).toHaveLength(1000);
      expect(page.nextAfter).toBe('job-0999');
      expect(page.truncated).toBe(true);
      const second = cli('--list', '--after', page.nextAfter!, '--confirm-offline');
      expect(second.status).toBe(0);
      const next = JSON.parse(second.stdout) as typeof page;
      expect(next.jobs.map((job) => job.id)).toEqual(['job-1000', 'job-1001']);
      expect(next.truncated).toBe(false);
      expect(next.nextAfter).toBeNull();
    } finally {
      await isolated.close();
    }
  }, 30_000);

  it('runs the read-only export inventory CLI against PostgreSQL', async () => {
    const account = await registerAccount(harness);
    const id = randomUUID();
    await harness.db.execute(
      `INSERT INTO exports (id, organisation_id, requested_by, format, filter, status, created_at)
       VALUES (?, ?, ?, 'csv', '{}', 'failed', ?)`,
      [id, account.organisationId, account.userId, '2000-01-01T00:00:00.000Z'],
    );
    const schema = await harness.db.one<{ schema: string }>('SELECT current_schema() AS schema');
    const url = new URL(process.env.DATABASE_URL!);
    url.searchParams.set('options', `-c search_path=${schema!.schema}`);
    const root = await mkdtemp(join(tmpdir(), 'idcp-pg-inventory-'));
    try {
      const run = spawnSync(
        process.execPath,
        ['--import', 'tsx', 'src/db/export-inventory-cli.ts', '--inspect', id, '--confirm-offline'],
        {
          cwd: resolve(__dirname, '..'),
          env: {
            PATH: process.env.PATH,
            NODE_ENV: 'test',
            DB_DRIVER: 'postgres',
            DATABASE_URL: url.toString(),
            STORAGE_PATH: root,
          },
          encoding: 'utf8',
        },
      );
      expect(run.status).toBe(0);
      expect(JSON.parse(run.stdout)).toMatchObject({
        found: true,
        export: { id, status: 'failed' },
        observations: [{ source: 'canonicalCandidate', file: 'missing' }],
      });
      expect(
        await harness.db.one('SELECT status, storage_key FROM exports WHERE id = ?', [id]),
      ).toEqual({ status: 'failed', storage_key: null });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 30_000);

  it('applies migrations and executes placeholder queries, transactions, and an API health check', async () => {
    expect(harness.db.driver).toBe('postgres');

    const schema = await harness.db.one<{ schema: string }>('SELECT current_schema() AS schema');
    expect(schema?.schema).toMatch(/^idcp_test_[a-f0-9]{32}$/);

    // Exercise the adapter's `?` → `$1` rewrite against PostgreSQL, not just a pure helper test.
    const echo = await harness.db.one<{ value: string }>('SELECT ?::text AS value', [
      'postgres-executed',
    ]);
    expect(echo?.value).toBe('postgres-executed');

    const organisationId = randomUUID();
    const timestamp = new Date().toISOString();
    await harness.db.transaction(async (transaction) => {
      await transaction.execute(
        'INSERT INTO organisations (id, name, slug, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
        [organisationId, 'Postgres smoke', `pg-${organisationId}`, timestamp, timestamp],
      );
    });
    const persisted = await harness.db.one<{ name: string }>(
      'SELECT name FROM organisations WHERE id = ?',
      [organisationId],
    );
    expect(persisted?.name).toBe('Postgres smoke');

    const auditId = randomUUID();
    await harness.db.execute(
      `INSERT INTO audit_logs (id, organisation_id, actor_type, actor_id, action, metadata, created_at)
       VALUES (?, ?, 'system', NULL, 'postgres.smoke', '{}', ?)`,
      [auditId, organisationId, timestamp],
    );
    await expect(
      harness.db.execute("UPDATE audit_logs SET action = 'tampered' WHERE id = ?", [auditId]),
    ).rejects.toThrow(/append-only/i);
    await expect(
      harness.db.execute('DELETE FROM audit_logs WHERE id = ?', [auditId]),
    ).rejects.toThrow(/append-only/i);

    const health = await harness.api.json('GET', '/api/v1/health');
    expect(health.statusCode).toBe(200);
    expect(health.json<{ status: string; dependencies: { db?: string } }>()).toMatchObject({
      status: 'ok',
      dependencies: { db: 'ok' },
    });
  });
});
