import type { Database } from '../../src/db/database';
import { SqliteDatabase } from '../../src/db/sqlite';
import { WorkerRecoveryRepository } from '../../src/repositories/worker-recovery-repo';

const [path, jobId] = process.argv.slice(2);
if (!path || !jobId || !process.send) throw new Error('Missing fixture inputs');
const db = new SqliteDatabase({ path });
const controlled = {
  transaction: <T>(run: (tx: Database) => Promise<T>) =>
    db.transaction((tx) =>
      run({
        ...tx,
        execute: async (sql, params) => {
          await tx.execute(sql, params);
          if (sql.includes('INSERT INTO audit_logs')) {
            process.send?.({ type: 'inside-abandon-transaction' });
            await new Promise<void>(() => undefined);
          }
        },
      }),
    ),
} as Database;
process.send({ type: 'ready' });
process.on('message', (message) => {
  if (message !== 'start') return;
  void new WorkerRecoveryRepository(controlled)
    .abandonWithAudit({
      id: jobId,
      attempt: 1,
      operatorReference: 'operator-test',
      incidentReference: 'INC-42',
    })
    .then(
      () => process.send?.({ type: 'unexpected-completion' }),
      () => process.send?.({ type: 'error' }),
    );
});
