import type {
  Connector,
  ConnectorContext,
  ConnectorDestinationSchema,
  ConnectorReadQuery,
  ConnectorRecord,
  ConnectorWriteResult,
} from './contract';
import { assertIdentifier } from './sqlite-connector';

/**
 * PostgreSQL connector (CON-003).
 *
 * Uses a dedicated connection for each operation and parameterised statements only. Table and
 * column names are validated identifiers because they cannot be passed as query parameters.
 */
export interface SqlConnectorConfig {
  connectionString: string;
  table: string;
  /** Legacy field; this connector always uses PostgreSQL. MySQL has its own connector. */
  driver?: 'postgres' | 'mysql';
}

interface Queryable {
  query(sql: string, params?: unknown[]): Promise<{ rows: Array<Record<string, unknown>> }>;
  end(): Promise<void>;
}

export class PostgresConnector implements Connector {
  readonly type = 'postgres';
  readonly label = 'PostgreSQL database';
  readonly capabilities = ['create', 'read', 'update', 'search'] as const;

  validateConfig(config: Record<string, unknown>): void {
    const parsed = config as Partial<SqlConnectorConfig>;
    if (!parsed.connectionString) throw new Error('SQL connector requires a "connectionString".');
    if (!/^postgres(ql)?:\/\//.test(parsed.connectionString)) {
      throw new Error('The connection string must start with postgres:// or postgresql://.');
    }
    if (!parsed.table) throw new Error('SQL connector requires a "table" name.');
    assertIdentifier(parsed.table, 'SQL table');
  }

  private async connect(
    config: Record<string, unknown>,
  ): Promise<{ db: Queryable; table: string }> {
    this.validateConfig(config);
    const parsed = config as unknown as SqlConnectorConfig;
    const table = assertIdentifier(parsed.table, 'SQL table');
    // Imported lazily: a deployment without a SQL destination never loads the driver.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { Pool } = require('pg') as typeof import('pg');
    const pool = new Pool({
      connectionString: parsed.connectionString,
      max: 1,
      connectionTimeoutMillis: 5000,
    });
    // BEGIN, every statement and COMMIT/ROLLBACK must use the same checked-out client. Pool.query
    // releases a connection between queries, so it is not a transaction ownership boundary.
    let client: import('pg').PoolClient;
    try {
      client = await pool.connect();
    } catch (error) {
      await pool.end().catch(() => undefined);
      throw error;
    }
    return {
      db: {
        query: async (sql, params) => {
          const result = await client.query(sql, params as never[]);
          return { rows: result.rows as Array<Record<string, unknown>> };
        },
        end: async () => {
          try {
            client.release();
          } finally {
            await pool.end();
          }
        },
      },
      table,
    };
  }

  async describeSchema(
    config: Record<string, unknown>,
    _context: ConnectorContext,
  ): Promise<ConnectorDestinationSchema> {
    void _context;
    const { db, table } = await this.connect(config);
    try {
      const { rows } = await db.query(
        `SELECT column_name, data_type, is_nullable
           FROM information_schema.columns
          WHERE (table_schema, table_name) = (
            SELECT n.nspname, c.relname
              FROM pg_catalog.pg_class c
              JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
             WHERE c.oid = pg_catalog.to_regclass($1)
          )
          ORDER BY ordinal_position`,
        [table],
      );
      return {
        container: table,
        fields: rows.map((row) => ({
          key: String(row.column_name),
          label: String(row.column_name),
          type: mapSqlType(String(row.data_type)),
          required: row.is_nullable === 'NO',
        })),
      };
    } finally {
      await db.end();
    }
  }

  async healthCheck(
    config: Record<string, unknown>,
    context: ConnectorContext,
  ): Promise<{ ok: boolean; error?: string }> {
    try {
      const { db } = await this.connect(config);
      try {
        await db.query('SELECT 1');
        return { ok: true };
      } finally {
        await db.end();
      }
    } catch (error) {
      context.logger.warn('sql connector health check failed', { error: (error as Error).message });
      return { ok: false, error: (error as Error).message };
    }
  }

  async create(
    records: ConnectorRecord[],
    config: Record<string, unknown>,
    context: ConnectorContext,
  ): Promise<ConnectorWriteResult> {
    const { db, table } = await this.connect(config);
    try {
      await db.query('BEGIN');
      let created = 0;
      try {
        for (const record of records) {
          const columns = Object.keys(record.values);
          if (columns.length === 0) continue;
          columns.forEach((column) => assertIdentifier(column, 'Destination column'));
          const placeholders = columns.map((_, index) => `$${index + 1}`).join(', ');
          await db.query(
            `INSERT INTO ${table} (${columns.join(', ')}) VALUES (${placeholders})`,
            columns.map((column) => record.values[column]),
          );
          created += 1;
        }
        await db.query('COMMIT');
      } catch (error) {
        await db.query('ROLLBACK');
        throw error;
      }
      context.logger.info('sql connector inserted rows', { created, table });
      return {
        created,
        updated: 0,
        skipped: 0,
        summary: `inserted ${created} row(s) into ${table}`,
      };
    } finally {
      await db.end();
    }
  }

  /** DUP-001: updates rows matching the duplicate keys, in one transaction. */
  async update(
    records: ConnectorRecord[],
    keys: string[],
    config: Record<string, unknown>,
    context: ConnectorContext,
  ): Promise<ConnectorWriteResult> {
    if (keys.length === 0) throw new Error('An update needs at least one duplicate key.');
    const { db, table } = await this.connect(config);
    let updated = 0;
    try {
      await db.query('BEGIN');
      try {
        for (const record of records) {
          const columns = Object.keys(record.values).filter((column) => !keys.includes(column));
          if (columns.length === 0) continue;
          columns.forEach((column) => assertIdentifier(column, 'Destination column'));
          keys.forEach((key) => assertIdentifier(key, 'Duplicate key'));
          const assignments = columns.map((column, index) => `${column} = $${index + 1}`);
          const where = keys.map((key, index) => `${key} = $${columns.length + index + 1}`);
          const { rows } = await db.query(
            `UPDATE ${table} SET ${assignments.join(', ')} WHERE ${where.join(' AND ')} RETURNING 1`,
            [
              ...columns.map((column) => record.values[column]),
              ...keys.map((key) => record.values[key]),
            ],
          );
          updated += rows.length;
        }
        await db.query('COMMIT');
      } catch (error) {
        await db.query('ROLLBACK');
        throw error;
      }
      context.logger.info('sql connector updated rows', { updated, table });
      return { created: 0, updated, skipped: 0, summary: `updated ${updated} row(s) in ${table}` };
    } finally {
      await db.end();
    }
  }

  async read(
    query: ConnectorReadQuery,
    config: Record<string, unknown>,
    _context: ConnectorContext,
  ): Promise<ConnectorRecord[]> {
    void _context;
    const { db, table } = await this.connect(config);
    try {
      const where = Object.keys(query.where ?? {});
      where.forEach((column) => assertIdentifier(column, 'Filter column'));
      const clause =
        where.length > 0
          ? ` WHERE ${where.map((column, index) => `${column} = $${index + 1}`).join(' AND ')}`
          : '';
      const { rows } = await db.query(
        `SELECT * FROM ${table}${clause} LIMIT $${where.length + 1}`,
        [...where.map((column) => query.where?.[column]), query.limit ?? 100],
      );
      return rows.map((row) => ({
        values: Object.fromEntries(
          Object.entries(row).map(([key, value]) => [
            key,
            typeof value === 'number' || typeof value === 'string' || typeof value === 'boolean'
              ? value
              : value === null || value === undefined
                ? null
                : String(value),
          ]),
        ),
      }));
    } finally {
      await db.end();
    }
  }
}

function mapSqlType(type: string): 'string' | 'number' | 'date' | 'boolean' {
  const lower = type.toLowerCase();
  if (
    ['int', 'numeric', 'real', 'double', 'decimal', 'float'].some((token) => lower.includes(token))
  ) {
    return 'number';
  }
  if (lower.includes('date') || lower.includes('time')) return 'date';
  if (lower.includes('bool')) return 'boolean';
  return 'string';
}
