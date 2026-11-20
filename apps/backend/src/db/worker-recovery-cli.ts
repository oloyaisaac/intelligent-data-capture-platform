import { existsSync } from 'node:fs';
import { loadConfig } from '../config';
import { JobsRepository } from '../repositories/system-repo';
import { WorkerRecoveryRepository } from '../repositories/worker-recovery-repo';
import type { Database } from './database';
import { PostgresDatabase } from './postgres';
import { SqliteDatabase } from './sqlite';

/** This command cannot verify that all workers are stopped or external effects are safe to retry. */
async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const listing = args.length === 2 && args[0] === '--list' && args[1] === '--confirm-offline';
  const recovering =
    args.length === 10 &&
    args[0] === '--requeue' &&
    !!args[1] &&
    args[2] === '--attempt' &&
    /^[1-9]\d*$/.test(args[3] ?? '') &&
    Number.isSafeInteger(Number(args[3])) &&
    args[4] === '--operator' &&
    /^[a-zA-Z0-9][a-zA-Z0-9_.:@/-]{0,79}$/.test(args[5] ?? '') &&
    args[6] === '--incident' &&
    /^[a-zA-Z0-9][a-zA-Z0-9_.:@/-]{0,79}$/.test(args[7] ?? '') &&
    args[8] === '--confirm-offline' &&
    args[9] === '--confirm-effects-reviewed';
  if (!listing && !recovering) {
    throw new Error('Invalid arguments');
  }
  const config = loadConfig();
  let db: Database;
  if (config.DB_DRIVER === 'postgres') {
    db = new PostgresDatabase({ connectionString: config.DATABASE_URL!, poolSize: 1 });
  } else {
    if (config.SQLITE_PATH === ':memory:' || !existsSync(config.SQLITE_PATH)) {
      throw new Error('Expected an existing persistent SQLite database');
    }
    db = new SqliteDatabase({ path: config.SQLITE_PATH });
  }
  try {
    const jobs = new JobsRepository(db);
    if (listing) {
      const count = await jobs.countRunning();
      const jobsToReview = await jobs.listRunningForRecovery();
      console.log(
        JSON.stringify({ count, jobs: jobsToReview, truncated: count > jobsToReview.length }),
      );
    } else {
      const changed = await new WorkerRecoveryRepository(db).requeueWithAudit({
        id: args[1]!,
        attempt: Number(args[3]),
        operatorReference: args[5]!,
        incidentReference: args[7]!,
      });
      console.log(JSON.stringify({ requeued: changed }));
      if (!changed) process.exitCode = 2;
    }
  } finally {
    await db.close();
  }
}

main().catch(() => {
  // Driver and configuration errors can contain connection strings and other secrets.
  console.error(
    'Worker recovery failed. See docs/worker-recovery.md for required arguments and offline controls.',
  );
  process.exitCode = 1;
});
