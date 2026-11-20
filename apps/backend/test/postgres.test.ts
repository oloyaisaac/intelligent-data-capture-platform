import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { JobsRepository } from '../src/repositories/system-repo';
import {
  createHarness,
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
            `SELECT COUNT(*)::int AS count FROM pg_stat_activity activity
             WHERE $1::int = ANY(pg_blocking_pids(activity.pid))
               AND activity.wait_event_type = 'Lock'
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
