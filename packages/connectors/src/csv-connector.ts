import { defuseFormula, toCsv, type CsvCell } from '@idcp/shared';
import { constants, type Stats } from 'node:fs';
import { writeFile, mkdir, lstat, open } from 'node:fs/promises';
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
 * end-to-end destination for testing the whole review → connector path. The shared writer guards
 * formula-like new cells; unsafe headers are rejected to preserve stable destination identities.
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
    if (parsed.delimiter !== undefined && ![',', ';', '\t', '|'].includes(parsed.delimiter)) {
      throw new Error('CSV delimiter is not supported.');
    }
    if (parsed.bom !== undefined && typeof parsed.bom !== 'boolean') {
      throw new Error('CSV bom must be a boolean.');
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
    if (records.length === 0) {
      return { created: 0, updated: 0, skipped: 0, summary: 'No rows to append.' };
    }
    const file = this.path(config);
    await mkdir(dirname(file), { recursive: true });

    const { rows: existingRows, headers, content, snapshot } = await this.readRaw(parsed, file);
    if (snapshot && headers.length === 0) {
      throw new Error('CSV destination is empty; review it before writing.');
    }
    const incomingHeaders = Object.keys(records[0]!.values);
    if (records.some((record) => Object.keys(record.values).length === 0)) {
      throw new Error('CSV records must contain at least one field.');
    }
    const finalHeaders = headers.length > 0 ? headers : incomingHeaders;
    const unknownColumns = [
      ...new Set(records.flatMap((record) => Object.keys(record.values))),
    ].filter((header) => !finalHeaders.includes(header));
    if (unknownColumns.length > 0) {
      throw new Error(
        `The CSV file already exists with different columns. Missing: ${unknownColumns.join(', ')}`,
      );
    }

    const rows: CsvCell[][] = records.map((record) =>
      finalHeaders.map((header) => (record.values[header] ?? null) as CsvCell),
    );
    validateHeaders(finalHeaders);
    const options = { delimiter: parsed.delimiter ?? ',' } as const;
    if (!snapshot) {
      // Do not replace a destination created after the read observed it missing.
      await writeFile(file, toCsv(finalHeaders, rows, { ...options, bom: parsed.bom ?? false }), {
        encoding: 'utf8',
        mode: 0o600,
        flag: 'wx',
      });
    } else {
      // Existing bytes, including formulas, quoting and line endings, are never reserialized.
      const header = toCsv(finalHeaders, [], options);
      const encoded = toCsv(finalHeaders, rows, options).slice(header.length);
      const separator = content.endsWith('\n') || content.endsWith('\r') ? '' : '\r\n';
      const handle = await open(
        file,
        constants.O_WRONLY |
          constants.O_APPEND |
          (constants.O_NOFOLLOW ?? 0) |
          (constants.O_NONBLOCK ?? 0),
      );
      try {
        const current = await handle.stat();
        if (!isRegularSingleLink(current) || !sameSnapshot(snapshot, current)) {
          throw new Error('CSV destination changed; review before retrying.');
        }
        await handle.writeFile(separator + encoded, 'utf8');
      } finally {
        await handle.close();
      }
    }
    context.logger.info('csv connector wrote rows', {
      added: rows.length,
      total: existingRows.length + rows.length,
    });

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
    this.validateConfig(config);
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
  ): Promise<{ headers: string[]; rows: CsvCell[][]; content: string; snapshot: Stats | null }> {
    let info: Stats;
    try {
      info = await lstat(file);
    } catch (error) {
      // Only an absent path is treated as an empty destination; do not mask IO failures.
      if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') {
        return { headers: [], rows: [], content: '', snapshot: null };
      }
      throw error;
    }
    if (!isRegularSingleLink(info)) throw new Error('CSV destination must be a regular file.');
    const handle = await open(
      file,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0),
    );
    try {
      const before = await handle.stat();
      if (!isRegularSingleLink(before) || !sameSnapshot(info, before)) {
        throw new Error('CSV destination changed; review before retrying.');
      }
      const bytes = await handle.readFile();
      const after = await handle.stat();
      if (!isRegularSingleLink(after) || !sameSnapshot(before, after)) {
        throw new Error('CSV destination changed; review before retrying.');
      }
      // Reject invalid UTF-8 rather than silently replacing bytes before interpreting the header.
      const content = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
      const [headerRow, ...rows] = parseStrictCsv(content, config.delimiter ?? ',');
      const headers = headerRow ?? [];
      if (headers.length > 0) {
        validateHeaders(headers);
        if (rows.some((row) => row.length !== headers.length)) {
          throw new Error('CSV destination contains rows with different column counts.');
        }
      }
      return { headers, rows, content, snapshot: after };
    } finally {
      await handle.close();
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

function isRegularSingleLink(info: Stats): boolean {
  return info.isFile() && info.nlink === 1;
}

function sameSnapshot(a: Stats, b: Stats): boolean {
  return (
    a.dev === b.dev &&
    a.ino === b.ino &&
    a.size === b.size &&
    a.mtimeMs === b.mtimeMs &&
    a.ctimeMs === b.ctimeMs
  );
}

function validateHeaders(headers: string[]): void {
  if (
    headers.length === 0 ||
    headers.some((header) => header.length === 0) ||
    new Set(headers).size !== headers.length
  ) {
    throw new Error('CSV destination must have distinct, non-empty column names.');
  }
  // Silently escaping a destination header would change the key used for later mapping/lookup.
  if (headers.some((header) => defuseFormula(header) !== header)) {
    throw new Error('CSV destination has a formula-like column name.');
  }
}

/** A strict connector-local parser: do not silently repair malformed destination data. */
function parseStrictCsv(input: string, delimiter: string): string[][] {
  const text = input.startsWith('\uFEFF') ? input.slice(1) : input;
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let state: 'start' | 'unquoted' | 'quoted' | 'closed' = 'start';
  let recordStarted = false;
  const finishField = () => {
    row.push(field);
    field = '';
    state = 'start';
  };
  for (let i = 0; i < text.length; i++) {
    const char = text[i]!;
    if (state === 'quoted') {
      if (char === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else state = 'closed';
      } else field += char;
      continue;
    }
    if (char === delimiter) {
      finishField();
      recordStarted = true;
    } else if (char === '\r' || char === '\n') {
      finishField();
      rows.push(row);
      row = [];
      recordStarted = false;
      if (char === '\r' && text[i + 1] === '\n') i++;
    } else if (char === '"') {
      if (state !== 'start') throw new Error('CSV destination is malformed.');
      state = 'quoted';
      recordStarted = true;
    } else {
      if (state === 'closed') throw new Error('CSV destination is malformed.');
      state = 'unquoted';
      field += char;
      recordStarted = true;
    }
  }
  if (state === 'quoted') throw new Error('CSV destination is malformed.');
  if (recordStarted) {
    finishField();
    rows.push(row);
  }
  return rows;
}
