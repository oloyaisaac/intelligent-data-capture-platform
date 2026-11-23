import { SqliteDatabase } from '../src/db/sqlite';
import { MIGRATIONS, applyMigrations } from '../src/db/migrations';
import type { Database } from '../src/db/database';

it('leaves legacy and old-binary workflow runs without a trusted approval snapshot', async () => {
  const db = new SqliteDatabase({ path: ':memory:' });
  try {
    await db.execute(
      'CREATE TABLE schema_migrations (id TEXT PRIMARY KEY, applied_at TEXT NOT NULL)',
    );
    await db.execute('CREATE TABLE workflow_runs (id TEXT PRIMARY KEY, status TEXT NOT NULL)');
    await db.execute(
      "INSERT INTO workflow_runs (id, status) VALUES ('legacy', 'awaiting_approval')",
    );
    for (const migration of MIGRATIONS.filter(
      (entry) => entry.id !== '015_workflow_approval_snapshot',
    )) {
      await db.execute('INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)', [
        migration.id,
        '2000-01-01T00:00:00.000Z',
      ]);
    }
    expect(await applyMigrations(db)).toEqual(['015_workflow_approval_snapshot']);
    expect(
      await db.one('SELECT status, approval_snapshot FROM workflow_runs WHERE id = ?', ['legacy']),
    ).toEqual({ status: 'awaiting_approval', approval_snapshot: null });
    await db.execute(
      "INSERT INTO workflow_runs (id, status) VALUES ('old-binary', 'awaiting_approval')",
    );
    expect(
      await db.one('SELECT approval_snapshot FROM workflow_runs WHERE id = ?', ['old-binary']),
    ).toEqual({ approval_snapshot: null });
    expect(await applyMigrations(db)).toEqual([]);
  } finally {
    await db.close();
  }
});

it('rolls back migration DDL when recording its marker fails and permits retry', async () => {
  const db = new SqliteDatabase({ path: ':memory:' });
  try {
    await db.execute(
      'CREATE TABLE schema_migrations (id TEXT PRIMARY KEY, applied_at TEXT NOT NULL)',
    );
    await db.execute('CREATE TABLE workflow_runs (id TEXT PRIMARY KEY)');
    for (const migration of MIGRATIONS.filter(
      (entry) => entry.id !== '015_workflow_approval_snapshot',
    )) {
      await db.execute('INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)', [
        migration.id,
        '2000-01-01',
      ]);
    }
    const intercept = (target: Database): Database => ({
      driver: target.driver,
      query: target.query.bind(target),
      one: target.one.bind(target),
      close: target.close.bind(target),
      transaction: (fn) => target.transaction((tx) => fn(intercept(tx))),
      execute: async (sql, params) => {
        if (
          sql.startsWith('INSERT INTO schema_migrations') &&
          params?.[0] === '015_workflow_approval_snapshot'
        ) {
          throw new Error('synthetic marker failure');
        }
        return target.execute(sql, params);
      },
    });
    const interrupted = intercept(db);
    await expect(applyMigrations(interrupted)).rejects.toThrow('synthetic marker failure');
    expect(
      (await db.query<{ name: string }>('PRAGMA table_info(workflow_runs)')).map(
        (column) => column.name,
      ),
    ).not.toContain('approval_snapshot');
    expect(
      await db.one('SELECT id FROM schema_migrations WHERE id = ?', [
        '015_workflow_approval_snapshot',
      ]),
    ).toBeNull();
    await expect(applyMigrations(db)).resolves.toEqual(['015_workflow_approval_snapshot']);
    await expect(applyMigrations(db)).resolves.toEqual([]);
  } finally {
    await db.close();
  }
});
