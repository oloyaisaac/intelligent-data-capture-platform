import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  nowIso,
  parseJson,
  toJson,
  toPostgresPlaceholders,
  type Database,
  type SqlParams,
} from './database';

/**
 * SQLite adapter (via Node's built-in `node:sqlite`).
 * Used for local development and the automated test suite; no native dependency required.
 */

export interface SqliteOptions {
  /** File path, or `:memory:` for an ephemeral database. */
  path: string;
}

export class SqliteDatabase implements Database {
  readonly driver = 'sqlite' as const;
  private readonly db: DatabaseSync;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(options: SqliteOptions) {
    if (options.path !== ':memory:') {
      const directory = dirname(options.path);
      if (directory && directory !== '.' && !existsSync(directory)) {
        mkdirSync(directory, { recursive: true });
      }
    }
    this.db = new DatabaseSync(options.path);
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec('PRAGMA foreign_keys = ON');
    this.db.exec('PRAGMA busy_timeout = 5000');
  }

  async query<T = Record<string, unknown>>(sql: string, params: SqlParams = []): Promise<T[]> {
    const statement = this.db.prepare(sql);
    return statement.all(...(params as never[])) as T[];
  }

  async one<T = Record<string, unknown>>(sql: string, params: SqlParams = []): Promise<T | null> {
    const rows = await this.query<T>(sql, params);
    return rows[0] ?? null;
  }

  async execute(sql: string, params: SqlParams = []): Promise<void> {
    const statement = this.db.prepare(sql);
    statement.run(...(params as never[]));
  }

  /**
   * Serialised transaction. `node:sqlite` is synchronous, so we chain transactions to avoid
   * interleaving statements from concurrent async handlers.
   */
  async transaction<T>(fn: (db: Database) => Promise<T>): Promise<T> {
    const run = async (): Promise<T> => {
      this.db.exec('BEGIN IMMEDIATE');
      try {
        const result = await fn(this);
        this.db.exec('COMMIT');
        return result;
      } catch (error) {
        try {
          this.db.exec('ROLLBACK');
        } catch {
          // Rolling back a transaction that already failed is not itself an error worth raising.
        }
        throw error;
      }
    };
    const chained = this.queue.then(run, run);
    this.queue = chained.then(
      () => undefined,
      () => undefined,
    );
    return chained;
  }

  async close(): Promise<void> {
    this.db.close();
  }
}

// Re-exported so adapters and repositories can share the same helpers.
export { nowIso, parseJson, toJson, toPostgresPlaceholders };
