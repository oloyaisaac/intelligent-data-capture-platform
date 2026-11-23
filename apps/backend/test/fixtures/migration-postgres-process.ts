import type { Database } from '../../src/db/database';
import { applyMigrations } from '../../src/db/migrations';
import { PostgresDatabase } from '../../src/db/postgres';

const connectionString = process.env.IDCP_MIGRATION_TEST_DATABASE_URL;
if (!connectionString || !process.send) throw new Error('Missing test inputs');
const db = new PostgresDatabase({ connectionString, poolSize: 1 });
const intercept = (target: Database): Database => ({
  driver: target.driver,
  query: target.query.bind(target),
  one: target.one.bind(target),
  close: target.close.bind(target),
  transaction: (fn) => target.transaction((tx) => fn(intercept(tx))),
  execute: async (sql, params) => {
    await target.execute(sql, params);
    if (sql === 'ALTER TABLE workflow_runs ADD COLUMN approval_snapshot TEXT') {
      const row = await target.one<{ pid: number }>('SELECT pg_backend_pid() AS pid');
      process.send?.({ type: 'inside', pid: row?.pid });
      await new Promise<void>(() => undefined);
    }
  },
});
process.on('message', (message) => {
  if (message !== 'start') return;
  void applyMigrations(intercept(db)).then(
    () => process.send?.({ type: 'unexpected-completion' }),
    async () => {
      await db.close();
      process.send?.({ type: 'error' }, () => process.disconnect?.());
    },
  );
});
process.send({ type: 'ready' });
