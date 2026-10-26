import { Pool } from 'pg';
import { toPostgresPlaceholders, type Database, type SqlParams } from './database';

/**
 * PostgreSQL adapter for production (DEC-003).
 *
 * SQL is authored with `?` placeholders and rewritten to `$1..$n` here, so both drivers share
 * one set of queries. Booleans are stored as INTEGER and timestamps as ISO TEXT to keep the
 * schema portable (DEC-013).
 */

export interface PostgresOptions {
  connectionString: string;
  poolSize?: number;
  /** Reject queries slower than this so a bad query cannot wedge a request forever. */
  statementTimeoutMs?: number;
}

export class PostgresDatabase implements Database {
  readonly driver = 'postgres' as const;
  private readonly pool: Pool;

  constructor(options: PostgresOptions) {
    this.pool = new Pool({
      connectionString: options.connectionString,
      max: options.poolSize ?? 10,
      statement_timeout: options.statementTimeoutMs ?? 15_000,
      idleTimeoutMillis: 30_000,
    });
  }

  async query<T = Record<string, unknown>>(sql: string, params: SqlParams = []): Promise<T[]> {
    const result = await this.pool.query(toPostgresPlaceholders(sql), params as never[]);
    return result.rows as T[];
  }

  async one<T = Record<string, unknown>>(sql: string, params: SqlParams = []): Promise<T | null> {
    const rows = await this.query<T>(sql, params);
    return rows[0] ?? null;
  }

  async execute(sql: string, params: SqlParams = []): Promise<void> {
    await this.pool.query(toPostgresPlaceholders(sql), params as never[]);
  }

  async transaction<T>(fn: (db: Database) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const scoped: Database = {
        driver: this.driver,
        query: async <R = Record<string, unknown>>(sql: string, params: SqlParams = []) => {
          const result = await client.query(toPostgresPlaceholders(sql), params as never[]);
          return result.rows as R[];
        },
        one: async <R = Record<string, unknown>>(sql: string, params: SqlParams = []) => {
          const result = await client.query(toPostgresPlaceholders(sql), params as never[]);
          return (result.rows[0] as R | undefined) ?? null;
        },
        execute: async (sql: string, params: SqlParams = []) => {
          await client.query(toPostgresPlaceholders(sql), params as never[]);
        },
        transaction: (inner) => inner(scoped),
        close: async () => undefined,
      };
      const result = await fn(scoped);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
