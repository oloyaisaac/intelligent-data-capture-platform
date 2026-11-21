import type { Database } from '../src/db/database';
import { SqliteDatabase } from '../src/db/sqlite';
import { SAFE_WORKER_ERRORS, WORKER_ERROR_REDACTED } from '../src/domain/worker-errors';
import { WorkerErrorRemediationRepository } from '../src/repositories/worker-error-remediation-repo';
import { createHarness, registerAccount } from './helpers';

async function insertJob(
  db: Database,
  org: string,
  id: string,
  error: string | null,
): Promise<void> {
  await db.execute(
    `INSERT INTO jobs (id, organisation_id, type, document_id, payload, status, attempts, max_attempts, last_error, run_after, started_at, finished_at, created_at)
     VALUES (?, ?, 'extract_document', 'doc-fixture', '{"sensitive":"payload"}', 'running', 3, 5, ?, 'run-time', 'start-time', NULL, 'create-time')`,
    [id, org, error],
  );
}

it('scopes remediation to one job, preserves safe messages, changes no execution state, and audits once', async () => {
  const harness = await createHarness();
  try {
    const account = await registerAccount(harness);
    const foreign = await registerAccount(harness, {
      email: 'foreign-worker-remediation@example.com',
    });
    await insertJob(harness.db, account.organisationId, 'target', 'SYNTHETIC-SECRET');
    await insertJob(harness.db, foreign.organisationId, 'foreign', 'FOREIGN-SECRET');
    for (const [i, value] of [...SAFE_WORKER_ERRORS, null].entries())
      await insertJob(harness.db, account.organisationId, `safe-${i}`, value);
    const repo = new WorkerErrorRemediationRepository(harness.db);
    const scope = { organisationId: account.organisationId, jobId: 'target' };
    const input = { ...scope, operatorReference: 'op-1', incidentReference: 'INC-42' };
    expect(await repo.list(account.organisationId, null)).toEqual({
      jobs: [{ jobId: 'target' }],
      nextAfter: null,
    });
    expect(await repo.check(scope)).toEqual({ found: true, eligible: true });
    expect(await repo.check({ ...scope, organisationId: foreign.organisationId })).toEqual({
      found: false,
      eligible: false,
    });
    expect(await repo.apply({ ...input, organisationId: foreign.organisationId })).toEqual({
      found: false,
      changed: false,
    });
    const results = await Promise.all([repo.apply(input), repo.apply(input)]);
    expect(results.filter((result) => result.changed)).toHaveLength(1);
    expect(await repo.check(scope)).toEqual({ found: true, eligible: false });
    expect(await repo.apply(input)).toEqual({ found: true, changed: false });
    expect(
      await harness.db.one(
        'SELECT type, document_id, payload, status, attempts, max_attempts, last_error, run_after, started_at, finished_at, created_at FROM jobs WHERE id = ?',
        ['target'],
      ),
    ).toEqual({
      type: 'extract_document',
      document_id: 'doc-fixture',
      payload: '{"sensitive":"payload"}',
      status: 'running',
      attempts: 3,
      max_attempts: 5,
      last_error: WORKER_ERROR_REDACTED,
      run_after: 'run-time',
      started_at: 'start-time',
      finished_at: null,
      created_at: 'create-time',
    });
    expect(await harness.db.one('SELECT last_error FROM jobs WHERE id = ?', ['foreign'])).toEqual({
      last_error: 'FOREIGN-SECRET',
    });
    for (const [i, value] of [...SAFE_WORKER_ERRORS, null].entries())
      expect(
        await harness.db.one('SELECT last_error FROM jobs WHERE id = ?', [`safe-${i}`]),
      ).toEqual({ last_error: value });
    const audits = await harness.db.query<{ metadata: string }>(
      'SELECT metadata FROM audit_logs WHERE action = ? AND target_id = ?',
      ['worker.error_remediated_offline', 'target'],
    );
    expect(audits).toHaveLength(1);
    expect(JSON.parse(audits[0]!.metadata)).toEqual({
      operatorReference: 'op-1',
      incidentReference: 'INC-42',
    });
    expect(JSON.stringify(audits)).not.toContain('SYNTHETIC-SECRET');
  } finally {
    await harness.close();
  }
});

it('rolls back a changed error when audit insertion fails', async () => {
  const harness = await createHarness();
  try {
    const account = await registerAccount(harness);
    await insertJob(harness.db, account.organisationId, 'target', 'SYNTHETIC-SECRET');
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
    await expect(
      new WorkerErrorRemediationRepository(db).apply({
        organisationId: account.organisationId,
        jobId: 'target',
        operatorReference: 'op',
        incidentReference: 'INC-42',
      }),
    ).rejects.toThrow('synthetic audit failure');
    expect(await harness.db.one('SELECT last_error FROM jobs WHERE id = ?', ['target'])).toEqual({
      last_error: 'SYNTHETIC-SECRET',
    });
  } finally {
    await harness.close();
  }
});

it('paginates eligible IDs only and rejects invalid scopes and audit references', async () => {
  const harness = await createHarness();
  try {
    const account = await registerAccount(harness);
    for (let i = 0; i < 101; i++)
      await insertJob(
        harness.db,
        account.organisationId,
        `job-${String(i).padStart(3, '0')}`,
        `SECRET-${i}`,
      );
    const repo = new WorkerErrorRemediationRepository(harness.db);
    const first = await repo.list(account.organisationId, null);
    expect(first.jobs).toHaveLength(100);
    expect(first.nextAfter).toBe('job-099');
    expect(JSON.stringify(first)).not.toContain('SECRET');
    expect(await repo.list(account.organisationId, first.nextAfter)).toEqual({
      jobs: [{ jobId: 'job-100' }],
      nextAfter: null,
    });
    await expect(repo.check({ organisationId: '', jobId: 'job-000' })).rejects.toThrow();
    await expect(
      repo.apply({
        organisationId: account.organisationId,
        jobId: 'job-000',
        operatorReference: 'not safe',
        incidentReference: 'incident',
      }),
    ).rejects.toThrow();
  } finally {
    await harness.close();
  }
}, 30_000);

it('uses binary scope and allowlist comparisons even on case-insensitive legacy columns', async () => {
  const db = new SqliteDatabase({ path: ':memory:' });
  try {
    await db.execute(
      'CREATE TABLE jobs (id TEXT COLLATE NOCASE PRIMARY KEY, organisation_id TEXT COLLATE NOCASE, last_error TEXT COLLATE NOCASE)',
    );
    await db.execute(
      'CREATE TABLE audit_logs (id TEXT, organisation_id TEXT, actor_type TEXT, actor_id TEXT, action TEXT, target_type TEXT, target_id TEXT, metadata TEXT, created_at TEXT)',
    );
    await db.execute('INSERT INTO jobs VALUES (?, ?, ?)', [
      'Job',
      'Org',
      SAFE_WORKER_ERRORS[0].toUpperCase(),
    ]);
    const repo = new WorkerErrorRemediationRepository(db);
    expect(await repo.check({ organisationId: 'org', jobId: 'Job' })).toEqual({
      found: false,
      eligible: false,
    });
    expect(await repo.check({ organisationId: 'Org', jobId: 'job' })).toEqual({
      found: false,
      eligible: false,
    });
    expect(await repo.check({ organisationId: 'Org', jobId: 'Job' })).toEqual({
      found: true,
      eligible: true,
    });
    expect(
      await repo.apply({
        organisationId: 'Org',
        jobId: 'Job',
        operatorReference: 'op',
        incidentReference: 'incident',
      }),
    ).toEqual({ found: true, changed: true });
  } finally {
    await db.close();
  }
});
