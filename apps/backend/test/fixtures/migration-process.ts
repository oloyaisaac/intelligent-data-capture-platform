import type { Database } from '../../src/db/database';
import { applyMigrations } from '../../src/db/migrations';
import { SqliteDatabase } from '../../src/db/sqlite';

const [path, mode] = process.argv.slice(2);
if (!path || !process.send) throw new Error('Missing test inputs');
const db = new SqliteDatabase({ path });
let release!: () => void;
const gate = new Promise<void>((resolve) => {
  release = resolve;
});
const intercept = (target: Database): Database => ({
  driver: target.driver,
  query: target.query.bind(target),
  one: target.one.bind(target),
  close: target.close.bind(target),
  transaction: (fn) => target.transaction((tx) => fn(intercept(tx))),
  execute: async (sql, params) => {
    await target.execute(sql, params);
    if (mode === 'hold' && sql === 'ALTER TABLE workflow_runs ADD COLUMN approval_snapshot TEXT') {
      process.send?.({ type: 'inside' });
      await gate;
    }
  },
});
process.on('message', (message) => {
  if (message === 'release') {
    release();
    return;
  }
  if (message !== 'start') return;
  process.send?.({ type: 'starting' });
  void applyMigrations(intercept(db)).then(
    async (applied) => {
      await db.close();
      process.send?.({ type: 'done', applied });
      process.disconnect?.();
    },
    async () => {
      await db.close();
      process.send?.({ type: 'error' });
      process.disconnect?.();
      process.exitCode = 1;
    },
  );
});
process.send({ type: 'ready' });
