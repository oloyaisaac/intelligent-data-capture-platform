import { toCsv, type CsvCell } from '@idcp/shared';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join, normalize } from 'node:path';
import type {
  Connector,
  ConnectorContext,
  ConnectorDestinationSchema,
  ConnectorReadQuery,
  ConnectorRecord,
  ConnectorWriteResult,
} from './contract';

/**
 * CSV file connector (FR-18 / CON-001).
 *
 * Writes to a directory configured per connector. Used for local deployments and as the simplest
 * end-to-end destination for testing the whole review → connector path. Formula injection is
 * neutralised by the shared CSV writer, not by this connector.
 */
export interface CsvConnectorConfig {
  directory: string;
  filename: string;
  delimiter?: ',' | ';' | '\t' | '|';
  bom?: boolean;
}

export class CsvFileConnector implements Connector {
  readonly type = 'csv';
  readonly label = 'CSV file';
  readonly capabilities = ['create', 'read'] as const;

  validateConfig(config: Record<string, unknown>): void {
    const parsed = config as Partial<CsvConnectorConfig>;
    if (!parsed.filename || typeof parsed.filename !== 'string') {
      throw new Error('CSV connector requires a "filename" (for example "invoices.csv").');
    }
    if (
      parsed.filename.includes('..') ||
      parsed.filename.startsWith('/') ||
      parsed.filename.includes('\\') ||
      parsed.filename.includes('/')
    ) {
      throw new Error('CSV "filename" must be a plain file name with no path segments.');
    }
    if (!parsed.directory || typeof parsed.directory !== 'string') {
      throw new Error('CSV connector requires a "directory".');
    }
  }

  private path(config: Record<string, unknown>): string {
    const parsed = config as unknown as CsvConnectorConfig;
    const resolved = normalize(join(parsed.directory, parsed.filename));
    if (!resolved.startsWith(normalize(parsed.directory))) {
      throw new Error('CSV destination resolves outside the configured directory.');
    }
    return resolved;
  }

  async describeSchema(
    _config: Record<string, unknown>,
    _context: ConnectorContext,
  ): Promise<ConnectorDestinationSchema> {
    void _config;
    void _context;
    // A CSV file has no fixed schema; the mapping profile defines the columns.
    return { container: 'csv', fields: [] };
  }

  async healthCheck(
    config: Record<string, unknown>,
    context: ConnectorContext,
  ): Promise<{ ok: boolean; error?: string }> {
    try {
      this.validateConfig(config);
      const file = this.path(config);
      await mkdir(dirname(file), { recursive: true });
      return { ok: true };
    } catch (error) {
      context.logger.warn('csv connector health check failed', { error: (error as Error).message });
      return { ok: false, error: (error as Error).message };
    }
  }

  async create(
    records: ConnectorRecord[],
    config: Record<string, unknown>,
    context: ConnectorContext,
  ): Promise<ConnectorWriteResult> {
    this.validateConfig(config);
    const parsed = config as unknown as CsvConnectorConfig;
    const file = this.path(config);
    await mkdir(dirname(file), { recursive: true });

    const { rows: existingRows, headers } = await this.readRaw(parsed, file);
    const incomingHeaders = records.length > 0 ? Object.keys(records[0]!.values) : [];
    const finalHeaders = headers.length > 0 ? headers : incomingHeaders;
    const unknownColumns = incomingHeaders.filter((header) => !finalHeaders.includes(header));
    if (unknownColumns.length > 0) {
      throw new Error(
        `The CSV file already exists with different columns. Missing: ${unknownColumns.join(', ')}`,
      );
    }

    const rows: CsvCell[][] = records.map((record) =>
      finalHeaders.map((header) => (record.values[header] ?? null) as CsvCell),
    );
    const combined = [...existingRows, ...rows];
    const body = toCsv(finalHeaders, combined, {
      delimiter: parsed.delimiter ?? ',',
      bom: parsed.bom ?? false,
    });
    await writeFile(file, body, { encoding: 'utf8', mode: 0o600 });
    context.logger.info('csv connector wrote rows', { added: rows.length, total: combined.length });

    return {
      created: rows.length,
      updated: 0,
      skipped: 0,
      summary: `appended ${rows.length} row(s) to ${parsed.filename}`,
    };
  }

  async read(
    query: ConnectorReadQuery,
    config: Record<string, unknown>,
    _context: ConnectorContext,
  ): Promise<ConnectorRecord[]> {
    void _context;
    const parsed = config as unknown as CsvConnectorConfig;
    const { rows, headers } = await this.readRaw(parsed, this.path(config));
    const mapped = rows
      .map((row) =>
        Object.fromEntries(headers.map((header, index) => [header, cellToValue(row[index])])),
      )
      .filter((record) =>
        Object.entries(query.where ?? {}).every(
          ([key, value]) => String(record[key] ?? '') === String(value),
        ),
      );
    return mapped.slice(0, query.limit ?? 100).map((values) => ({ values }));
  }

  private async readRaw(
    config: CsvConnectorConfig,
    file: string,
  ): Promise<{ headers: string[]; rows: CsvCell[][] }> {
    const { parseCsv } = await import('@idcp/shared');
    try {
      const content = await readFile(file, 'utf8');
      const [headerRow, ...rows] = parseCsv(content, config.delimiter ?? ',');
      return { headers: headerRow ?? [], rows: rows as CsvCell[][] };
    } catch {
      return { headers: [], rows: [] };
    }
  }
}

/** CSV cells are strings; dates and nulls are normalised to connector-safe values. */
function cellToValue(cell: unknown): string | number | boolean | null {
  if (cell === null || cell === undefined) return null;
  if (cell instanceof Date) return cell.toISOString();
  if (typeof cell === 'number' || typeof cell === 'boolean') return cell;
  return String(cell);
}
