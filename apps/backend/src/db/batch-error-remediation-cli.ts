import { existsSync } from 'node:fs';
import { loadConfig } from '../config';
import { BatchErrorRemediationRepository } from '../repositories/batch-error-remediation-repo';
import type { Database } from './database';
import { PostgresDatabase } from './postgres';
import { ReadOnlySqliteDatabase } from './read-only-sqlite';
import { SqliteDatabase } from './sqlite';

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const id = /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,255}$/;
  const reference = /^[a-zA-Z0-9][a-zA-Z0-9_.:@/-]{0,79}$/;
  const list =
    args[0] === '--list' &&
    args[1] === '--organisation' &&
    id.test(args[2] ?? '') &&
    ((args.length === 4 && args[3] === '--confirm-offline') ||
      (args.length === 6 &&
        args[3] === '--after' &&
        id.test(args[4] ?? '') &&
        args[5] === '--confirm-offline'));
  const scoped =
    args[1] === '--organisation' &&
    id.test(args[2] ?? '') &&
    args[3] === '--batch' &&
    id.test(args[4] ?? '');
  const check =
    scoped && args.length === 6 && args[0] === '--check' && args[5] === '--confirm-offline';
  const apply =
    scoped &&
    args.length === 11 &&
    args[0] === '--apply' &&
    args[5] === '--operator' &&
    reference.test(args[6] ?? '') &&
    args[7] === '--incident' &&
    reference.test(args[8] ?? '') &&
    args[9] === '--confirm-offline' &&
    args[10] === '--confirm-loss-reviewed';
  if (!list && !check && !apply) throw new Error('Invalid arguments');
  const config = loadConfig();
  let db: Database;
  if (config.DB_DRIVER === 'postgres') {
    const pg = new PostgresDatabase({ connectionString: config.DATABASE_URL!, poolSize: 1 });
    if (check || list) {
      try {
        await pg.execute('SET default_transaction_read_only = on');
      } catch (error) {
        await pg.close();
        throw error;
      }
    }
    db = pg;
  } else {
    if (config.SQLITE_PATH === ':memory:' || !existsSync(config.SQLITE_PATH))
      throw new Error('Expected existing SQLite database');
    db =
      check || list
        ? new ReadOnlySqliteDatabase(config.SQLITE_PATH)
        : new SqliteDatabase({ path: config.SQLITE_PATH });
  }
  try {
    const repo = new BatchErrorRemediationRepository(db);
    if (list) {
      console.log(JSON.stringify(await repo.list(args[2]!, args.length === 6 ? args[4]! : null)));
    } else {
      const scope = { organisationId: args[2]!, batchId: args[4]! };
      const result = check
        ? await repo.check(scope)
        : await repo.apply({ ...scope, operatorReference: args[6]!, incidentReference: args[8]! });
      console.log(JSON.stringify(result));
      if (!result.found) process.exitCode = 2;
    }
  } finally {
    await db.close();
  }
}

main().catch(() => {
  console.error(
    'Batch error remediation failed. See docs/batch-error-remediation.md for usage and controls.',
  );
  process.exitCode = 1;
});
