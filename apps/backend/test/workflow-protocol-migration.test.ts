import { SqliteDatabase } from '../src/db/sqlite';
import { MIGRATIONS, applyMigrations } from '../src/db/migrations';

it('marks existing workflow rows as legacy and applies the protocol migration only once', async () => {
  const db = new SqliteDatabase({ path: ':memory:' });
  try {
    await db.execute(
      'CREATE TABLE schema_migrations (id TEXT PRIMARY KEY, applied_at TEXT NOT NULL)',
    );
    await db.execute('CREATE TABLE workflow_runs (id TEXT PRIMARY KEY, status TEXT NOT NULL)');
    await db.execute("INSERT INTO workflow_runs (id, status) VALUES ('legacy-run', 'matched')");
    for (const migration of MIGRATIONS.filter(
      (entry) => entry.id !== '012_workflow_execution_protocol',
    )) {
      await db.execute('INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)', [
        migration.id,
        '2000-01-01T00:00:00.000Z',
      ]);
    }
    expect(await applyMigrations(db)).toEqual(['012_workflow_execution_protocol']);
    expect(
      await db.one('SELECT status, execution_protocol FROM workflow_runs WHERE id = ?', [
        'legacy-run',
      ]),
    ).toEqual({ status: 'matched', execution_protocol: 0 });
    expect(await applyMigrations(db)).toEqual([]);
    await db.execute("INSERT INTO workflow_runs (id, status) VALUES ('old-binary-run', 'matched')");
    expect(
      await db.one('SELECT execution_protocol FROM workflow_runs WHERE id = ?', ['old-binary-run']),
    ).toEqual({ execution_protocol: 0 });
  } finally {
    await db.close();
  }
});
