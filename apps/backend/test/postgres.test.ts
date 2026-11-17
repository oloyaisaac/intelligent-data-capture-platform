import { randomUUID } from 'node:crypto';
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
