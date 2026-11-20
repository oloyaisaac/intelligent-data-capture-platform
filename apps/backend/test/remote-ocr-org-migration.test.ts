import { SqliteDatabase } from '../src/db/sqlite';
import { MIGRATIONS, applyMigrations } from '../src/db/migrations';
import { loadConfig } from '../src/config';

it('adds an initially empty organisation counter once, without fabricating historical usage', async () => {
  const db = new SqliteDatabase({ path: ':memory:' });
  try {
    await db.execute(
      'CREATE TABLE schema_migrations (id TEXT PRIMARY KEY, applied_at TEXT NOT NULL)',
    );
    await db.execute('CREATE TABLE organisations (id TEXT PRIMARY KEY)');
    await db.execute("INSERT INTO organisations (id) VALUES ('legacy')");
    for (const migration of MIGRATIONS.filter(
      (entry) => entry.id !== '014_remote_ocr_organisation_count',
    ))
      await db.execute('INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)', [
        migration.id,
        '2000-01-01T00:00:00.000Z',
      ]);
    expect(await applyMigrations(db)).toEqual(['014_remote_ocr_organisation_count']);
    expect(await db.query('SELECT * FROM remote_ocr_organisation_counts')).toEqual([]);
    expect(await applyMigrations(db)).toEqual([]);
    await expect(
      db.execute(
        "INSERT INTO remote_ocr_organisation_counts (organisation_id, invocations) VALUES ('legacy', -1)",
      ),
    ).rejects.toThrow();
    await expect(
      db.execute(
        "INSERT INTO remote_ocr_organisation_counts (organisation_id, invocations) VALUES ('missing', 1)",
      ),
    ).rejects.toThrow();
  } finally {
    await db.close();
  }
});

it('validates the per-organisation cap, including zero as a kill switch', () => {
  expect(loadConfig({}).AI_MAX_REMOTE_CALLS_PER_ORG).toBe(10_000);
  expect(loadConfig({ AI_MAX_REMOTE_CALLS_PER_ORG: '0' }).AI_MAX_REMOTE_CALLS_PER_ORG).toBe(0);
  expect(loadConfig({ AI_MAX_REMOTE_CALLS_PER_ORG: '10000000' }).AI_MAX_REMOTE_CALLS_PER_ORG).toBe(
    10_000_000,
  );
  for (const value of ['-1', '1.5', '10000001'])
    expect(() => loadConfig({ AI_MAX_REMOTE_CALLS_PER_ORG: value })).toThrow(
      /AI_MAX_REMOTE_CALLS_PER_ORG/,
    );
});
