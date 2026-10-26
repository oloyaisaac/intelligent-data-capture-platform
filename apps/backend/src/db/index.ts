import type { Config } from '../config';
import type { Logger } from '../logger';
import { applyMigrations } from './migrations';
import { PostgresDatabase } from './postgres';
import { SqliteDatabase } from './sqlite';
import type { Database } from './database';

export * from './database';
export * from './migrations';
export { SqliteDatabase } from './sqlite';
export { PostgresDatabase } from './postgres';

export async function createDatabase(config: Config, logger: Logger): Promise<Database> {
  if (config.DB_DRIVER === 'postgres') {
    const db = new PostgresDatabase({
      connectionString: config.DATABASE_URL as string,
      poolSize: config.DATABASE_POOL_SIZE,
    });
    const applied = await applyMigrations(db);
    if (applied.length > 0) logger.info('database migrations applied', { migrations: applied });
    return db;
  }

  const db = new SqliteDatabase({ path: config.SQLITE_PATH });
  const applied = await applyMigrations(db);
  if (applied.length > 0) logger.info('database migrations applied', { migrations: applied });
  return db;
}

/** Fresh in-memory database for tests. */
export async function createTestDatabase(): Promise<Database> {
  const db = new SqliteDatabase({ path: ':memory:' });
  await applyMigrations(db);
  return db;
}
