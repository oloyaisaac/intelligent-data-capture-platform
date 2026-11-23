import type { Database } from '../src/db/database';
import { MIGRATIONS, applyMigrations } from '../src/db/migrations';
import { SqliteDatabase } from '../src/db/sqlite';

function failOn(db: Database, predicate: (sql: string, params?: unknown[]) => boolean): Database {
  return {
    driver: db.driver,
    query: db.query.bind(db),
    one: db.one.bind(db),
    close: db.close.bind(db),
    transaction: (fn) => db.transaction((tx) => fn(failOn(tx, predicate))),
    execute: async (sql, params) => {
      if (predicate(sql, params)) throw new Error('synthetic migration failure');
      return db.execute(sql, params);
    },
  };
}

it('rolls back all pending migrations including ledger creation when a later marker fails', async () => {
  const db = new SqliteDatabase({ path: ':memory:' });
  try {
    const failing = failOn(
      db,
      (sql, params) =>
        sql.startsWith('INSERT INTO schema_migrations') &&
        params?.[0] === '015_workflow_approval_snapshot',
    );
    await expect(applyMigrations(failing)).rejects.toThrow('synthetic migration failure');
    expect(
      await db.one(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'",
      ),
    ).toBeNull();
    expect(
      await db.one(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'organisations'",
      ),
    ).toBeNull();
    expect(await applyMigrations(db)).toEqual(MIGRATIONS.map((migration) => migration.id));
    expect(await applyMigrations(db)).toEqual([]);
  } finally {
    await db.close();
  }
});
