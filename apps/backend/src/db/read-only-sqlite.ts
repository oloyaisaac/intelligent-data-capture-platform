import { DatabaseSync } from 'node:sqlite';
import type { Database, SqlParams } from './database';

/** A narrow offline reader: SQLite opens an existing database read-only, without applying migrations. */
export class ReadOnlySqliteDatabase implements Database {
  readonly driver = 'sqlite' as const;
  private readonly db: DatabaseSync;

  constructor(path: string) {
    this.db = new DatabaseSync(path, { readOnly: true });
  }

  async query<T = Record<string, unknown>>(sql: string, params: SqlParams = []): Promise<T[]> {
    return this.db.prepare(sql).all(...(params as never[])) as T[];
  }

  async one<T = Record<string, unknown>>(sql: string, params: SqlParams = []): Promise<T | null> {
    return (await this.query<T>(sql, params))[0] ?? null;
  }

  async execute(): Promise<void> {
    throw new Error('Read-only database');
  }

  async transaction<T>(): Promise<T> {
    throw new Error('Read-only database');
  }

  async close(): Promise<void> {
    this.db.close();
  }
}
