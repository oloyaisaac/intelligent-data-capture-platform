import { existsSync } from 'node:fs';
import { loadConfig } from '../config';
import { JobsRepository } from '../repositories/system-repo';
import type { Database } from './database';
import { PostgresDatabase } from './postgres';
import { SqliteDatabase } from './sqlite';

/** This command cannot verify that all workers are stopped or external effects are safe to retry. */
async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const listing = args.length === 2 && args[0] === '--list' && args[1] === '--confirm-offline';
  const recovering =
    args.length === 6 &&
    args[0] === '--requeue' &&
    !!args[1] &&
    args[2] === '--attempt' &&
    /^[1-9]\d*$/.test(args[3] ?? '') &&
    Number.isSafeInteger(Number(args[3])) &&
    args[4] === '--confirm-offline' &&
    args[5] === '--confirm-effects-reviewed';
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
      const changed = await jobs.requeueInterrupted(args[1]!, Number(args[3]));
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
    'Worker recovery failed. Use --list --confirm-offline, or --requeue JOB_ID --attempt N --confirm-offline --confirm-effects-reviewed; see docs/worker-recovery.md.',
  );
  process.exitCode = 1;
});
