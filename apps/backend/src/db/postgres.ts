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
  /** Called with no error details when an idle pooled connection is lost. */
  onIdleConnectionError?: () => void;
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
    // pg emits pool errors for idle connections; an unhandled event would terminate the process.
    this.pool.on('error', () => {
      try {
        options.onIdleConnectionError?.();
      } catch {
        // A monitoring callback must not turn an idle connection failure into an uncaught event.
      }
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
    let active = true;
    let connectionError: Error | undefined;
    let rejectConnection!: (error: Error) => void;
    const connectionLost = new Promise<never>((_, reject) => {
      rejectConnection = reject;
    });
    const onError = (error: Error) => {
      connectionError = error;
      active = false;
      rejectConnection(error);
    };
    client.on('error', onError);
    const assertActive = () => {
      if (!active) throw new Error('Transaction-scoped database is no longer active.');
    };
    try {
      await Promise.race([client.query('BEGIN'), connectionLost]);
      const scoped: Database = {
        driver: this.driver,
        query: async <R = Record<string, unknown>>(sql: string, params: SqlParams = []) => {
          assertActive();
          const result = await client.query(toPostgresPlaceholders(sql), params as never[]);
          return result.rows as R[];
        },
        one: async <R = Record<string, unknown>>(sql: string, params: SqlParams = []) => {
          assertActive();
          const result = await client.query(toPostgresPlaceholders(sql), params as never[]);
          return (result.rows[0] as R | undefined) ?? null;
        },
        execute: async (sql: string, params: SqlParams = []) => {
          assertActive();
          await client.query(toPostgresPlaceholders(sql), params as never[]);
        },
        transaction: (inner) => {
          assertActive();
          return inner(scoped);
        },
        close: async () => {
          assertActive();
        },
      };
      const result = await Promise.race([Promise.resolve().then(() => fn(scoped)), connectionLost]);
      assertActive();
      active = false;
      await Promise.race([client.query('COMMIT'), connectionLost]);
      return result;
    } catch (error) {
      active = false;
      // Connection loss or commit failure may be ambiguous. Never treat rollback as proof of outcome.
      if (!connectionError) await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      active = false;
      client.release(connectionError);
      client.removeListener('error', onError);
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
