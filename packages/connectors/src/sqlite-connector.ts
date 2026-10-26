import type {
  Connector,
  ConnectorContext,
  ConnectorDestinationSchema,
  ConnectorReadQuery,
  ConnectorRecord,
  ConnectorWriteResult,
} from './contract';

/**
 * SQLite connector (CON-003). Uses Node's built-in `node:sqlite`, so it works with no native
 * build step. Inserts run inside a transaction: a failure leaves the destination untouched.
 */
export interface SqliteConnectorConfig {
  path: string;
  table: string;
}

const SAFE_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]{0,62}$/;

export function assertIdentifier(value: string, what: string): string {
  if (!SAFE_IDENTIFIER.test(value)) {
    throw new Error(`${what} must be a simple identifier (letters, digits and underscores).`);
  }
  return value;
}

export class SqliteConnector implements Connector {
  readonly type = 'sqlite';
  readonly label = 'SQLite database';
  readonly capabilities = ['create', 'read', 'search'] as const;

  validateConfig(config: Record<string, unknown>): void {
    const parsed = config as Partial<SqliteConnectorConfig>;
    if (!parsed.path) throw new Error('SQLite connector requires a "path" to the database file.');
    if (!parsed.table) throw new Error('SQLite connector requires a "table" name.');
    assertIdentifier(parsed.table, 'SQLite table');
  }

  private open(config: Record<string, unknown>) {
    this.validateConfig(config);
    const parsed = config as unknown as SqliteConnectorConfig;
    // Imported lazily so a deployment that never uses SQLite does not pay for the module.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { DatabaseSync } = require('node:sqlite') as typeof import('node:sqlite');
    return {
      db: new DatabaseSync(parsed.path),
      table: assertIdentifier(parsed.table, 'SQLite table'),
    };
  }

  async describeSchema(
    config: Record<string, unknown>,
    _context: ConnectorContext,
  ): Promise<ConnectorDestinationSchema> {
    void _context;
    const { db, table } = this.open(config);
    try {
      const columns = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{
        name: string;
        type: string;
        notnull: number;
      }>;
      return {
        container: table,
        fields: columns.map((column) => ({
          key: column.name,
          label: column.name,
          type: mapSqlType(column.type),
          required: column.notnull === 1,
        })),
      };
    } finally {
      db.close();
    }
  }

  async healthCheck(
    config: Record<string, unknown>,
    context: ConnectorContext,
  ): Promise<{ ok: boolean; error?: string }> {
    try {
      const { db, table } = this.open(config);
      try {
        const found = db
          .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
          .get(table) as { name?: string } | undefined;
        if (!found?.name) {
          // A connection that succeeds but points at the wrong table is not healthy.
          return { ok: false, error: `Table "${table}" does not exist in this database.` };
        }
        return { ok: true };
      } finally {
        db.close();
      }
    } catch (error) {
      context.logger.warn('sqlite connector health check failed', {
        error: (error as Error).message,
      });
      return { ok: false, error: (error as Error).message };
    }
  }

  async create(
    records: ConnectorRecord[],
    config: Record<string, unknown>,
    context: ConnectorContext,
  ): Promise<ConnectorWriteResult> {
    const { db, table } = this.open(config);
    try {
      db.exec('BEGIN IMMEDIATE');
      let created = 0;
      try {
        for (const record of records) {
          const columns = Object.keys(record.values);
          if (columns.length === 0) continue;
          columns.forEach((column) => assertIdentifier(column, 'Destination column'));
          const placeholders = columns.map(() => '?').join(', ');
          const statement = db.prepare(
            `INSERT INTO ${table} (${columns.join(', ')}) VALUES (${placeholders})`,
          );
          statement.run(...(columns.map((column) => record.values[column]) as never[]));
          created += 1;
        }
        db.exec('COMMIT');
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
      context.logger.info('sqlite connector inserted rows', { created, table });
      return {
        created,
        updated: 0,
        skipped: 0,
        summary: `inserted ${created} row(s) into ${table}`,
      };
    } finally {
      db.close();
    }
  }

  /** DUP-001: updates the row(s) matching the duplicate keys, inside one transaction. */
  async update(
    records: ConnectorRecord[],
    keys: string[],
    config: Record<string, unknown>,
    context: ConnectorContext,
  ): Promise<ConnectorWriteResult> {
    if (keys.length === 0) throw new Error('An update needs at least one duplicate key.');
    const { db, table } = this.open(config);
    try {
      db.exec('BEGIN IMMEDIATE');
      let updated = 0;
      try {
        for (const record of records) {
          const columns = Object.keys(record.values).filter((column) => !keys.includes(column));
          if (columns.length === 0) continue;
          columns.forEach((column) => assertIdentifier(column, 'Destination column'));
          keys.forEach((key) => assertIdentifier(key, 'Duplicate key'));
          const statement = db.prepare(
            `UPDATE ${table} SET ${columns.map((column) => `${column} = ?`).join(', ')}
              WHERE ${keys.map((key) => `${key} = ?`).join(' AND ')}`,
          );
          const result = statement.run(
            ...([
              ...columns.map((column) => record.values[column]),
              ...keys.map((key) => record.values[key]),
            ] as never[]),
          );
          updated += Number(result.changes ?? 0);
        }
        db.exec('COMMIT');
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
      context.logger.info('sqlite connector updated rows', { updated, table });
      return {
        created: 0,
        updated,
        skipped: 0,
        summary: `updated ${updated} row(s) in ${table}`,
      };
    } finally {
      db.close();
    }
  }

  async read(
    query: ConnectorReadQuery,
    config: Record<string, unknown>,
    _context: ConnectorContext,
  ): Promise<ConnectorRecord[]> {
    void _context;
    const { db, table } = this.open(config);
    try {
      const where = Object.keys(query.where ?? {});
      where.forEach((column) => assertIdentifier(column, 'Filter column'));
      const clause =
        where.length > 0 ? ` WHERE ${where.map((column) => `${column} = ?`).join(' AND ')}` : '';
      const statement = db.prepare(`SELECT * FROM ${table}${clause} LIMIT ?`);
      const rows = statement.all(
        ...(where.map((column) => query.where?.[column]) as never[]),
        query.limit ?? 100,
      ) as Array<Record<string, unknown>>;
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
      db.close();
    }
  }
}

function mapSqlType(type: string): 'string' | 'number' | 'date' | 'boolean' {
  const lower = type.toLowerCase();
  if (
    ['int', 'integer', 'real', 'numeric', 'float', 'double'].some((token) => lower.includes(token))
  ) {
    return 'number';
  }
  if (lower.includes('date') || lower.includes('time')) return 'date';
  if (lower.includes('bool')) return 'boolean';
  return 'string';
}
