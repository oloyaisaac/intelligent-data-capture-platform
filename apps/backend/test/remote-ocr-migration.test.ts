import { SqliteDatabase } from '../src/db/sqlite';
import { MIGRATIONS, applyMigrations } from '../src/db/migrations';
import { loadConfig } from '../src/config';

it('upgrades existing documents once with zero counted calls, without claiming a historical count', async () => {
  const db = new SqliteDatabase({ path: ':memory:' });
  try {
    await db.execute(
      'CREATE TABLE schema_migrations (id TEXT PRIMARY KEY, applied_at TEXT NOT NULL)',
    );
    await db.execute('CREATE TABLE documents (id TEXT PRIMARY KEY)');
    await db.execute("INSERT INTO documents (id) VALUES ('legacy')");
    for (const migration of MIGRATIONS.filter(
      (entry) => entry.id !== '013_remote_ocr_invocation_count',
    )) {
      await db.execute('INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)', [
        migration.id,
        '2000-01-01T00:00:00.000Z',
      ]);
    }
    expect(await applyMigrations(db)).toEqual(['013_remote_ocr_invocation_count']);
    expect(
      await db.one('SELECT remote_ocr_invocations FROM documents WHERE id = ?', ['legacy']),
    ).toEqual({ remote_ocr_invocations: 0 });
    expect(await applyMigrations(db)).toEqual([]);
    await expect(
      db.execute("UPDATE documents SET remote_ocr_invocations = -1 WHERE id = 'legacy'"),
    ).rejects.toThrow();
  } finally {
    await db.close();
  }
});

it('validates the invocation limit and allows an explicit zero kill switch', () => {
  expect(loadConfig({}).AI_MAX_REMOTE_CALLS_PER_DOC).toBe(5);
  expect(loadConfig({ AI_MAX_REMOTE_CALLS_PER_DOC: '0' }).AI_MAX_REMOTE_CALLS_PER_DOC).toBe(0);
  expect(() => loadConfig({ AI_MAX_REMOTE_CALLS_PER_DOC: '-1' })).toThrow(
    /AI_MAX_REMOTE_CALLS_PER_DOC/,
  );
  expect(() => loadConfig({ AI_MAX_REMOTE_CALLS_PER_DOC: '1001' })).toThrow(
    /AI_MAX_REMOTE_CALLS_PER_DOC/,
  );
  expect(() => loadConfig({ AI_MAX_REMOTE_CALLS_PER_DOC: '1.5' })).toThrow(
    /AI_MAX_REMOTE_CALLS_PER_DOC/,
  );
});
