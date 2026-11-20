import { existsSync } from 'node:fs';
import { loadConfig } from '../config';
import { JobsRepository } from '../repositories/system-repo';
import { WorkerRecoveryRepository } from '../repositories/worker-recovery-repo';
import type { Database } from './database';
import { PostgresDatabase } from './postgres';
import { SqliteDatabase } from './sqlite';
import { ReadOnlySqliteDatabase } from './read-only-sqlite';

/** This command cannot verify that all workers are stopped or external effects are safe to retry. */
async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const listing = args.length === 2 && args[0] === '--list' && args[1] === '--confirm-offline';
  const listingAfter =
    args.length === 4 &&
    args[0] === '--list' &&
    args[1] === '--after' &&
    !!args[2] &&
    args[2].length <= 256 &&
    args[3] === '--confirm-offline';
  const recoveryArguments =
    !!args[1] &&
    args[1].length <= 256 &&
    args[2] === '--attempt' &&
    /^[1-9]\d*$/.test(args[3] ?? '') &&
    Number.isSafeInteger(Number(args[3])) &&
    args[4] === '--operator' &&
    /^[a-zA-Z0-9][a-zA-Z0-9_.:@/-]{0,79}$/.test(args[5] ?? '') &&
    args[6] === '--incident' &&
    /^[a-zA-Z0-9][a-zA-Z0-9_.:@/-]{0,79}$/.test(args[7] ?? '') &&
    args[8] === '--confirm-offline' &&
    args[9] === '--confirm-effects-reviewed';
  const recovering = recoveryArguments && args.length === 10 && args[0] === '--requeue';
  const abandoning =
    recoveryArguments &&
    args.length === 11 &&
    args[0] === '--abandon' &&
    args[10] === '--confirm-no-retry';
  if (!listing && !listingAfter && !recovering && !abandoning) {
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
    db =
      listing || listingAfter
        ? new ReadOnlySqliteDatabase(config.SQLITE_PATH)
        : new SqliteDatabase({ path: config.SQLITE_PATH });
  }
  try {
    if (listing || listingAfter) {
      const list = async (connection: Database) => {
        const jobs = new JobsRepository(connection);
        const count = await jobs.countRunning();
        const rows = await jobs.listRunningForRecovery(listingAfter ? args[2]! : null);
        const page = rows.slice(0, 1000);
        const truncated = rows.length > page.length;
        return {
          count,
          jobs: page,
          truncated,
          nextAfter: truncated ? page[page.length - 1]!.id : null,
        };
      };
      const result =
        db.driver === 'postgres'
          ? await db.transaction(async (tx) => {
              await tx.execute('SET TRANSACTION READ ONLY');
              return list(tx);
            })
          : await list(db);
      console.log(JSON.stringify(result));
    } else {
      const recovery = new WorkerRecoveryRepository(db);
      const input = {
        id: args[1]!,
        attempt: Number(args[3]),
        operatorReference: args[5]!,
        incidentReference: args[7]!,
      };
      if (abandoning) {
        const result = await recovery.abandonWithAudit(input);
        console.log(JSON.stringify(result));
        if (!result.abandoned) process.exitCode = 2;
      } else {
        const changed = await recovery.requeueWithAudit(input);
        console.log(JSON.stringify({ requeued: changed }));
        if (!changed) process.exitCode = 2;
      }
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
