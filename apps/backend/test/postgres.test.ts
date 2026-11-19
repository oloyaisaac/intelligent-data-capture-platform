import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { JobsRepository } from '../src/repositories/system-repo';
import { createHarness, type Harness } from './helpers';

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

  it('lets only one blocked claimant update a single queued job', async () => {
    const jobs = new JobsRepository(harness.db);
    const job = await jobs.enqueue({ organisationId: randomUUID(), type: 'test-concurrent-claim' });
    const observer = new Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
    let claims: Promise<Awaited<ReturnType<JobsRepository['claimNext']>>[]> | undefined;
    try {
      // Hold the target row while both updates select the same queued row and block on its lock.
      await harness.db.transaction(async (tx) => {
        await tx.one('SELECT id FROM jobs WHERE id = ? FOR UPDATE', [job.id]);
        const locker = await tx.one<{ pid: number }>('SELECT pg_backend_pid() AS pid');
        if (!locker) throw new Error('Could not identify the row-locking session');
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
               AND activity.query LIKE 'UPDATE jobs SET status = %'`,
            [locker.pid],
          );
          blocked = result.rows[0]?.count ?? 0;
          if (blocked < 2) await new Promise((resolve) => setTimeout(resolve, 25));
        }
        expect(blocked).toBeGreaterThanOrEqual(2);
      });
      const results = await claims!;
      expect(results.filter((row) => row !== null)).toHaveLength(1);
      expect(results.find((row) => row !== null)?.id).toBe(job.id);
      const stored = await jobs.findById(job.id);
      expect(stored?.status).toBe('running');
      expect(Number(stored?.attempts)).toBe(1);
    } finally {
      await observer.end();
      if (claims) await claims.catch(() => undefined);
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
