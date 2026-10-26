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
 * MySQL/MariaDB connector (CON-003).
 *
 * Deliberately separate from the Postgres connector rather than a flag: the two differ in
 * placeholder style (`?` vs `$1`), how the current schema is named, and how identifiers are
 * quoted, and hiding those differences behind a boolean produces SQL that works on one and fails
 * on the other.
 *
 * The driver (`mysql2/promise`) is required lazily so a deployment that never uses MySQL does not
 * load it. Table and column names are validated identifiers because they cannot be parameters.
 */
export interface MysqlConnectorConfig {
  connectionString: string;
  table: string;
  /** Optional schema; defaults to the schema in the connection string. */
  database?: string;
}

interface Queryable {
  query(sql: string, params?: unknown[]): Promise<[unknown, unknown]>;
  end(): Promise<void>;
}

export class MysqlConnector implements Connector {
  readonly type = 'mysql';
  readonly label = 'MySQL database';
  readonly capabilities = ['create', 'read', 'update', 'search'] as const;

  validateConfig(config: Record<string, unknown>): void {
    const parsed = config as Partial<MysqlConnectorConfig>;
    if (!parsed.connectionString) throw new Error('MySQL connector requires a "connectionString".');
    if (!/^mysql:\/\//.test(parsed.connectionString)) {
      throw new Error('The connection string must start with mysql://.');
    }
    if (!parsed.table) throw new Error('MySQL connector requires a "table" name.');
    assertIdentifier(parsed.table, 'MySQL table');
    if (parsed.database) assertIdentifier(parsed.database, 'MySQL database');
  }

  private async connect(
    config: Record<string, unknown>,
  ): Promise<{ db: Queryable; table: string; database: string | null }> {
    this.validateConfig(config);
    const parsed = config as unknown as MysqlConnectorConfig;
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mysql = require('mysql2/promise') as {
      createConnection(options: { uri: string }): Promise<Queryable>;
    };
    const connection = await mysql.createConnection({ uri: parsed.connectionString });
    return {
      db: connection,
      table: assertIdentifier(parsed.table, 'MySQL table'),
      database: parsed.database ? assertIdentifier(parsed.database, 'MySQL database') : null,
    };
  }

  async describeSchema(
    config: Record<string, unknown>,
    _context: ConnectorContext,
  ): Promise<ConnectorDestinationSchema> {
    void _context;
    const { db, table, database } = await this.connect(config);
    try {
      const [rows] = await db.query(
        `SELECT column_name, data_type, is_nullable
           FROM information_schema.columns
          WHERE table_name = ? AND table_schema = ${database ? '?' : 'DATABASE()'}
          ORDER BY ordinal_position`,
        database ? [table, database] : [table],
      );
      return {
        container: table,
        fields: (rows as Array<Record<string, unknown>>).map((row) => ({
          key: String(row.column_name ?? row.COLUMN_NAME),
          label: String(row.column_name ?? row.COLUMN_NAME),
          type: mapMysqlType(String(row.data_type ?? row.DATA_TYPE)),
          required: (row.is_nullable ?? row.IS_NULLABLE) === 'NO',
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
      context.logger.warn('mysql connector health check failed', {
        error: (error as Error).message,
      });
      return { ok: false, error: (error as Error).message };
    }
  }

  /** Inserts all records inside one transaction: either every row lands, or none do. */
  async create(
    records: ConnectorRecord[],
    config: Record<string, unknown>,
    context: ConnectorContext,
  ): Promise<ConnectorWriteResult> {
    const { db, table } = await this.connect(config);
    let created = 0;
    try {
      await db.query('START TRANSACTION');
      try {
        for (const record of records) {
          const columns = Object.keys(record.values);
          if (columns.length === 0) continue;
          columns.forEach((column) => assertIdentifier(column, 'Destination column'));
          await db.query(
            `INSERT INTO \`${table}\` (${columns.map((column) => `\`${column}\``).join(', ')})
             VALUES (${columns.map(() => '?').join(', ')})`,
            columns.map((column) => record.values[column]),
          );
          created += 1;
        }
        await db.query('COMMIT');
      } catch (error) {
        await db.query('ROLLBACK');
        throw error;
      }
      context.logger.info('mysql connector inserted rows', { created, table });
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
          ? ` WHERE ${where.map((column) => `\`${column}\` = ?`).join(' AND ')}`
          : '';
      const [rows] = await db.query(`SELECT * FROM \`${table}\`${clause} LIMIT ?`, [
        ...where.map((column) => query.where?.[column]),
        query.limit ?? 100,
      ]);
      return (rows as Array<Record<string, unknown>>).map((row) => ({
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

function mapMysqlType(type: string): 'string' | 'number' | 'date' | 'boolean' {
  const lower = type.toLowerCase();
  if (
    ['int', 'numeric', 'real', 'double', 'decimal', 'float', 'bit'].some((token) =>
      lower.includes(token),
    )
  ) {
    return 'number';
  }
  if (lower.includes('date') || lower.includes('time') || lower.includes('year')) return 'date';
  if (lower.includes('bool')) return 'boolean';
  return 'string';
}
