import { DatabaseSync } from 'node:sqlite';
import { AsyncLocalStorage } from 'node:async_hooks';
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
  private readonly transactionContext = new AsyncLocalStorage<{ active: boolean }>();

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

  private enqueue<T>(run: () => T | Promise<T>): Promise<T> {
    if (this.transactionContext.getStore()?.active) {
      return Promise.reject(new Error('Use the transaction-scoped database inside a transaction.'));
    }
    const result = this.queue.then(run, run);
    this.queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private queryDirect<T>(sql: string, params: SqlParams): T[] {
    return this.db.prepare(sql).all(...(params as never[])) as T[];
  }

  private executeDirect(sql: string, params: SqlParams): void {
    this.db.prepare(sql).run(...(params as never[]));
  }

  query<T = Record<string, unknown>>(sql: string, params: SqlParams = []): Promise<T[]> {
    return this.enqueue(() => this.queryDirect<T>(sql, params));
  }

  one<T = Record<string, unknown>>(sql: string, params: SqlParams = []): Promise<T | null> {
    return this.enqueue(() => this.queryDirect<T>(sql, params)[0] ?? null);
  }

  execute(sql: string, params: SqlParams = []): Promise<void> {
    return this.enqueue(() => this.executeDirect(sql, params));
  }

  /** All connection operations share a queue; only the scoped handle can execute during a transaction. */
  transaction<T>(fn: (db: Database) => Promise<T>): Promise<T> {
    return this.enqueue(async () => {
      this.db.exec('BEGIN IMMEDIATE');
      const context = { active: true };
      const assertActive = () => {
        if (!context.active) throw new Error('Transaction-scoped database is no longer active.');
      };
      const scoped: Database = {
        driver: this.driver,
        query: async <R = Record<string, unknown>>(sql: string, params: SqlParams = []) => {
          assertActive();
          return this.queryDirect<R>(sql, params);
        },
        one: async <R = Record<string, unknown>>(sql: string, params: SqlParams = []) => {
          assertActive();
          return this.queryDirect<R>(sql, params)[0] ?? null;
        },
        execute: async (sql: string, params: SqlParams = []) => {
          assertActive();
          this.executeDirect(sql, params);
        },
        // Like the PostgreSQL adapter, nested calls participate in the same transaction; no savepoint.
        transaction: async (inner) => {
          assertActive();
          return inner(scoped);
        },
        close: async () => {
          assertActive();
        },
      };
      try {
        const result = await this.transactionContext.run(context, () => fn(scoped));
        this.db.exec('COMMIT');
        return result;
      } catch (error) {
        try {
          this.db.exec('ROLLBACK');
        } catch {
          // Preserve the original error if the transaction was already rolled back.
        }
        throw error;
      } finally {
        context.active = false;
      }
    });
  }

  close(): Promise<void> {
    return this.enqueue(() => this.db.close());
  }
}

// Re-exported so adapters and repositories can share the same helpers.
export { nowIso, parseJson, toJson, toPostgresPlaceholders };
