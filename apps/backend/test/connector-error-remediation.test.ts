import type { Database } from '../src/db/database';
import { SqliteDatabase } from '../src/db/sqlite';
import { CONNECTOR_HEALTH_FAILURE, CONNECTOR_RUN_FAILURE } from '../src/domain/connector-errors';
import { ConnectorErrorRemediationRepository } from '../src/repositories/connector-error-remediation-repo';
import { createHarness, registerAccount } from './helpers';

async function connector(
  db: Database,
  org: string,
  id: string,
  error: string | null,
): Promise<void> {
  await db.execute(
    `INSERT INTO connectors (id, organisation_id, type, name, status, last_error, created_at, updated_at)
     VALUES (?, ?, 'csv', 'fixture', 'error', ?, ?, ?)`,
    [id, org, error, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'],
  );
}
async function run(
  db: Database,
  org: string,
  connectorId: string,
  id: string,
  error: string | null,
): Promise<void> {
  await db.execute(
    `INSERT INTO connector_runs (id, organisation_id, connector_id, operation, status, error, request_summary, response_summary, created_at)
     VALUES (?, ?, ?, 'create', 'failed', ?, 'request-secret', 'response-secret', ?)`,
    [id, org, connectorId, error, '2026-01-01T00:00:00.000Z'],
  );
}

it('remediates only scoped errors in bounded audited transactions without reading historical text', async () => {
  const harness = await createHarness();
  try {
    const account = await registerAccount(harness);
    const foreign = await registerAccount(harness, {
      email: 'foreign-connector-errors@example.com',
    });
    await connector(harness.db, account.organisationId, 'target', 'health-secret');
    await connector(harness.db, foreign.organisationId, 'foreign', 'foreign-health-secret');
    for (let i = 0; i < 102; i++)
      await run(
        harness.db,
        account.organisationId,
        'target',
        `run-${String(i).padStart(3, '0')}`,
        `secret-${i}`,
      );
    await run(harness.db, account.organisationId, 'target', 'run-safe', CONNECTOR_RUN_FAILURE);
    await run(harness.db, account.organisationId, 'target', 'run-null', null);
    await run(harness.db, foreign.organisationId, 'target', 'cross-tenant', 'foreign-run-secret');
    await run(harness.db, foreign.organisationId, 'foreign', 'foreign-run', 'foreign-run-secret');
    await run(
      harness.db,
      account.organisationId,
      'deleted-connector',
      'orphan-run',
      'orphan-secret',
    );

    const repo = new ConnectorErrorRemediationRepository(harness.db);
    const scope = { organisationId: account.organisationId, connectorId: 'target' };
    const input = { ...scope, operatorReference: 'operator-1', incidentReference: 'INC-42' };
    expect(await repo.list(account.organisationId, null)).toEqual({
      connectors: [{ connectorId: 'target' }],
      nextAfter: null,
    });
    expect(await repo.check(scope)).toEqual({
      found: true,
      healthEligible: true,
      runEligible: 102,
    });
    expect(await repo.check({ ...scope, organisationId: foreign.organisationId })).toEqual({
      found: false,
      healthEligible: false,
      runEligible: 0,
    });
    expect(await repo.apply({ ...input, organisationId: foreign.organisationId })).toEqual({
      found: false,
      healthChanged: false,
      runsChanged: 0,
      remaining: false,
    });
    const results = await Promise.all([repo.apply(input), repo.apply(input)]);
    expect(results.map((result) => result.runsChanged).sort((a, b) => b - a)).toEqual([100, 2]);
    expect(results.filter((result) => result.healthChanged)).toHaveLength(1);
    expect(await repo.check(scope)).toEqual({ found: true, healthEligible: false, runEligible: 0 });
    expect(await repo.apply(input)).toEqual({
      found: true,
      healthChanged: false,
      runsChanged: 0,
      remaining: false,
    });
    expect(
      await harness.db.one('SELECT last_error FROM connectors WHERE id = ?', ['target']),
    ).toEqual({ last_error: CONNECTOR_HEALTH_FAILURE });
    const rows = await harness.db.query<{
      error: string | null;
      request_summary: string;
      response_summary: string;
    }>(
      'SELECT error, request_summary, response_summary FROM connector_runs WHERE organisation_id = ? AND connector_id = ?',
      [account.organisationId, 'target'],
    );
    expect(rows.filter((row) => row.error === CONNECTOR_RUN_FAILURE)).toHaveLength(103);
    expect(rows.filter((row) => row.error === null)).toHaveLength(1);
    expect(
      rows.every(
        (row) =>
          row.request_summary === 'request-secret' && row.response_summary === 'response-secret',
      ),
    ).toBe(true);
    expect(
      await harness.db.one('SELECT error FROM connector_runs WHERE id = ?', ['cross-tenant']),
    ).toEqual({ error: 'foreign-run-secret' });
    expect(
      await harness.db.one('SELECT error FROM connector_runs WHERE id = ?', ['orphan-run']),
    ).toEqual({ error: 'orphan-secret' });
    const audits = await harness.db.query<{ metadata: string }>(
      'SELECT metadata FROM audit_logs WHERE action = ? AND target_id = ?',
      ['connector.errors_remediated_offline', 'target'],
    );
    expect(audits).toHaveLength(2);
    expect(
      audits
        .map((item) => JSON.parse(item.metadata).runsChanged)
        .sort((a: number, b: number) => b - a),
    ).toEqual([100, 2]);
    expect(JSON.stringify(audits)).not.toContain('secret');
  } finally {
    await harness.close();
  }
}, 30_000);

it('rolls back health and run updates if audit insertion fails', async () => {
  const harness = await createHarness();
  try {
    const account = await registerAccount(harness);
    await connector(harness.db, account.organisationId, 'target', 'health-secret');
    await run(harness.db, account.organisationId, 'target', 'one', 'run-secret');
    const db: Database = {
      driver: harness.db.driver,
      query: harness.db.query.bind(harness.db),
      one: harness.db.one.bind(harness.db),
      execute: harness.db.execute.bind(harness.db),
      close: async () => undefined,
      transaction: (fn) =>
        harness.db.transaction((tx) =>
          fn({
            driver: tx.driver,
            query: tx.query.bind(tx),
            one: tx.one.bind(tx),
            close: async () => undefined,
            transaction: tx.transaction.bind(tx),
            execute: async (sql, params) => {
              if (sql.includes('INSERT INTO audit_logs'))
                throw new Error('synthetic audit failure');
              return tx.execute(sql, params);
            },
          }),
        ),
    };
    const repo = new ConnectorErrorRemediationRepository(db);
    await expect(
      repo.apply({
        organisationId: account.organisationId,
        connectorId: 'target',
        operatorReference: 'op',
        incidentReference: 'INC-42',
      }),
    ).rejects.toThrow('synthetic audit failure');
    expect(
      await harness.db.one('SELECT last_error FROM connectors WHERE id = ?', ['target']),
    ).toEqual({ last_error: 'health-secret' });
    expect(await harness.db.one('SELECT error FROM connector_runs WHERE id = ?', ['one'])).toEqual({
      error: 'run-secret',
    });
  } finally {
    await harness.close();
  }
});

it('paginates connector IDs without returning errors and rejects invalid arguments', async () => {
  const harness = await createHarness();
  try {
    const account = await registerAccount(harness);
    for (let i = 0; i < 101; i++)
      await connector(
        harness.db,
        account.organisationId,
        `item-${String(i).padStart(3, '0')}`,
        'SECRET',
      );
    const repo = new ConnectorErrorRemediationRepository(harness.db);
    const first = await repo.list(account.organisationId, null);
    expect(first.connectors).toHaveLength(100);
    expect(first.nextAfter).toBe('item-099');
    expect(JSON.stringify(first)).not.toContain('SECRET');
    expect(await repo.list(account.organisationId, first.nextAfter)).toEqual({
      connectors: [{ connectorId: 'item-100' }],
      nextAfter: null,
    });
    await expect(repo.check({ organisationId: '', connectorId: 'item-000' })).rejects.toThrow();
    await expect(
      repo.apply({
        organisationId: account.organisationId,
        connectorId: 'item-000',
        operatorReference: 'not safe',
        incidentReference: 'incident',
      }),
    ).rejects.toThrow();
  } finally {
    await harness.close();
  }
}, 30_000);

it('uses exact binary scope and message comparisons even if legacy columns use NOCASE', async () => {
  const db = new SqliteDatabase({ path: ':memory:' });
  try {
    await db.execute(
      'CREATE TABLE connectors (id TEXT COLLATE NOCASE PRIMARY KEY, organisation_id TEXT COLLATE NOCASE, last_error TEXT COLLATE NOCASE)',
    );
    await db.execute(
      'CREATE TABLE connector_runs (id TEXT COLLATE NOCASE PRIMARY KEY, organisation_id TEXT COLLATE NOCASE, connector_id TEXT COLLATE NOCASE, error TEXT COLLATE NOCASE)',
    );
    await db.execute(
      'CREATE TABLE audit_logs (id TEXT, organisation_id TEXT, actor_type TEXT, actor_id TEXT, action TEXT, target_type TEXT, target_id TEXT, metadata TEXT, created_at TEXT)',
    );
    await db.execute('INSERT INTO connectors VALUES (?, ?, ?)', [
      'Target',
      'Org',
      CONNECTOR_HEALTH_FAILURE.toUpperCase(),
    ]);
    await db.execute('INSERT INTO connector_runs VALUES (?, ?, ?, ?)', [
      'right',
      'Org',
      'Target',
      CONNECTOR_RUN_FAILURE.toUpperCase(),
    ]);
    await db.execute('INSERT INTO connector_runs VALUES (?, ?, ?, ?)', [
      'wrong-org',
      'org',
      'Target',
      'FOREIGN',
    ]);
    await db.execute('INSERT INTO connector_runs VALUES (?, ?, ?, ?)', [
      'wrong-connector',
      'Org',
      'target',
      'FOREIGN',
    ]);
    const repo = new ConnectorErrorRemediationRepository(db);
    expect(await repo.check({ organisationId: 'org', connectorId: 'Target' })).toEqual({
      found: false,
      healthEligible: false,
      runEligible: 0,
    });
    expect(await repo.check({ organisationId: 'Org', connectorId: 'target' })).toEqual({
      found: false,
      healthEligible: false,
      runEligible: 0,
    });
    expect(await repo.check({ organisationId: 'Org', connectorId: 'Target' })).toEqual({
      found: true,
      healthEligible: true,
      runEligible: 1,
    });
    expect(
      await repo.apply({
        organisationId: 'Org',
        connectorId: 'Target',
        operatorReference: 'op',
        incidentReference: 'incident',
      }),
    ).toEqual({ found: true, healthChanged: true, runsChanged: 1, remaining: false });
    expect(await db.one('SELECT error FROM connector_runs WHERE id = ?', ['wrong-org'])).toEqual({
      error: 'FOREIGN',
    });
    expect(
      await db.one('SELECT error FROM connector_runs WHERE id = ?', ['wrong-connector']),
    ).toEqual({ error: 'FOREIGN' });
  } finally {
    await db.close();
  }
});
