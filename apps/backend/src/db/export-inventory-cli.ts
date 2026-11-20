import { existsSync } from 'node:fs';
import { loadConfig } from '../config';
import { ExportInventoryRepository } from '../repositories/export-inventory-repo';
import { inspectExportInventory, listExportInventory } from '../services/export-inventory';
import type { Database } from './database';
import { PostgresDatabase } from './postgres';
import { ReadOnlySqliteDatabase } from './read-only-sqlite';

/** Read-only inventory; confirmations are assertions and do not stop or fence writers. */
async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const list = args.length === 2 && args[0] === '--list' && args[1] === '--confirm-offline';
  const listAfter =
    args.length === 4 &&
    args[0] === '--list' &&
    args[1] === '--after' &&
    !!args[2] &&
    args[2].length <= 256 &&
    args[3] === '--confirm-offline';
  const inspect =
    args.length === 3 &&
    args[0] === '--inspect' &&
    !!args[1] &&
    args[1].length <= 256 &&
    args[2] === '--confirm-offline';
  if (!list && !listAfter && !inspect) throw new Error('Invalid arguments');
  const config = loadConfig();
  let db: Database;
  if (config.DB_DRIVER === 'postgres') {
    const postgres = new PostgresDatabase({ connectionString: config.DATABASE_URL!, poolSize: 1 });
    try {
      await postgres.execute('SET default_transaction_read_only = on');
    } catch (error) {
      await postgres.close();
      throw error;
    }
    db = postgres;
  } else {
    if (config.SQLITE_PATH === ':memory:' || !existsSync(config.SQLITE_PATH)) {
      throw new Error('Expected an existing persistent SQLite database');
    }
    db = new ReadOnlySqliteDatabase(config.SQLITE_PATH);
  }
  try {
    const repository = new ExportInventoryRepository(db);
    if (list || listAfter) {
      console.log(
        JSON.stringify(await listExportInventory(repository, listAfter ? args[2]! : null)),
      );
    } else {
      const result = await inspectExportInventory(repository, config.STORAGE_PATH, args[1]!);
      if (result === null) {
        console.log(JSON.stringify({ found: false }));
        process.exitCode = 2;
      } else {
        console.log(JSON.stringify({ found: true, ...result }));
      }
    }
  } finally {
    await db.close();
  }
}

main().catch(() => {
  // Do not print filesystem paths, database URLs, exception messages or credentials.
  console.error('Export inventory failed. See docs/export-inventory.md for offline usage.');
  process.exitCode = 1;
});
