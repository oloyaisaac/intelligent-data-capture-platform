import { existsSync } from 'node:fs';
import { loadConfig } from '../config';
import {
  StorageInventoryRepository,
  type StorageReferenceKind,
} from '../repositories/storage-inventory-repo';
import {
  isInventoryComponent,
  listStorageInventory,
  listStorageReferences,
  type StorageInventoryKind,
} from '../services/storage-inventory';
import type { Database } from './database';
import { PostgresDatabase } from './postgres';
import { ReadOnlySqliteDatabase } from './read-only-sqlite';

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const references = args[0] === '--references';
  const base =
    (args[0] === '--list' || references) &&
    args[1] === '--organisation' &&
    isInventoryComponent(args[2] ?? '') &&
    args[3] === '--kind' &&
    (references
      ? ['documents', 'exports', 'pages', 'templates']
      : ['documents', 'exports', 'pages']
    ).includes(args[4] ?? '');
  const first =
    base &&
    args.length === 7 &&
    args[5] === '--confirm-offline' &&
    args[6] === '--confirm-sensitive-output';
  const next =
    base &&
    args.length === 9 &&
    args[5] === '--after' &&
    isInventoryComponent(args[6] ?? '') &&
    args[7] === '--confirm-offline' &&
    args[8] === '--confirm-sensitive-output';
  if (!first && !next) throw new Error('Invalid arguments');
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
    if (config.SQLITE_PATH === ':memory:' || !existsSync(config.SQLITE_PATH))
      throw new Error('Expected an existing persistent SQLite database');
    db = new ReadOnlySqliteDatabase(config.SQLITE_PATH);
  }
  try {
    const repo = new StorageInventoryRepository(db);
    const result = references
      ? await listStorageReferences(
          repo,
          config.STORAGE_PATH,
          args[2]!,
          args[4]! as StorageReferenceKind,
          next ? args[6]! : null,
        )
      : await listStorageInventory(
          repo,
          config.STORAGE_PATH,
          args[2]!,
          args[4]! as StorageInventoryKind,
          next ? args[6]! : null,
        );
    console.log(JSON.stringify(result));
  } finally {
    await db.close();
  }
}

main().catch(() => {
  // Do not print raw database URLs, keys, filesystem paths or driver exception text.
  console.error(
    'Storage inventory failed. See docs/storage-inventory.md for offline usage and limits.',
  );
  process.exitCode = 1;
});
