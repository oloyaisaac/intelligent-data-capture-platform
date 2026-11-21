import type {
  Connector,
  ConnectorContext,
  ConnectorDestinationSchema,
  ConnectorReadQuery,
  ConnectorRecord,
  ConnectorWriteResult,
} from './contract';
import { boundedFetch, checkedTimeout } from './crm/safe-http';

/**
 * Google Sheets connector (CON-002).
 *
 * Talks to the Sheets v4 REST API with an OAuth access token supplied by the caller (refreshing
 * is the backend's job). Legacy backend configuration can still contain plaintext tokens.
 * Appends respect existing
 * headers and never rewrite unrelated columns.
 */
export interface GoogleSheetsConfig {
  spreadsheetId: string;
  sheetName: string;
  /** OAuth bearer token supplied at runtime; legacy backend config may contain plaintext. */
  accessToken?: string;
  /** Request deadline in milliseconds, from 1 to 120000. */
  timeoutMs?: number;
}

const SHEETS_API = 'https://sheets.googleapis.com/v4/spreadsheets';

export class GoogleSheetsConnector implements Connector {
  readonly type = 'google_sheets';
  readonly label = 'Google Sheets';
  readonly capabilities = ['create', 'read', 'search'] as const;

  validateConfig(config: Record<string, unknown>): void {
    const parsed = config as Partial<GoogleSheetsConfig>;
    if (!parsed.spreadsheetId)
      throw new Error('Google Sheets connector requires a "spreadsheetId".');
    if (!parsed.sheetName) throw new Error('Google Sheets connector requires a "sheetName".');
    checkedTimeout(parsed.timeoutMs);
    if (!/^[A-Za-z0-9_-]{20,}$/.test(parsed.spreadsheetId)) {
      throw new Error('That "spreadsheetId" does not look like a Google Sheets id.');
    }
  }

  private url(config: GoogleSheetsConfig, suffix: string): string {
    return `${SHEETS_API}/${encodeURIComponent(config.spreadsheetId)}/${suffix}`;
  }

  private headers(config: GoogleSheetsConfig): Record<string, string> {
    if (!config.accessToken) {
      throw new Error('Google Sheets access has expired. Reconnect the connector.');
    }
    return {
      authorization: `Bearer ${config.accessToken}`,
      'content-type': 'application/json',
    };
  }

  async describeSchema(
    config: Record<string, unknown>,
    context: ConnectorContext,
  ): Promise<ConnectorDestinationSchema> {
    this.validateConfig(config);
    const parsed = config as unknown as GoogleSheetsConfig;
    const response = await boundedFetch(
      context,
      this.url(parsed, `values/${encodeURIComponent(`${parsed.sheetName}!1:1`)}`),
      { headers: this.headers(parsed) },
      parsed.timeoutMs,
    );
    if (!response.ok) {
      throw new Error(describeSheetsError(response.status, 'read the header row'));
    }
    const [header = []] = parseSheetRows(response.text);
    validateHeaders(header);
    return {
      container: parsed.sheetName,
      fields: header.map((key) => ({ key, label: key, type: 'string' })),
    };
  }

  async healthCheck(
    config: Record<string, unknown>,
    context: ConnectorContext,
  ): Promise<{ ok: boolean; error?: string }> {
    try {
      await this.describeSchema(config, context);
      return { ok: true };
    } catch (error) {
      return { ok: false, error: (error as Error).message };
    }
  }

  async create(
    records: ConnectorRecord[],
    config: Record<string, unknown>,
    context: ConnectorContext,
  ): Promise<ConnectorWriteResult> {
    this.validateConfig(config);
    const parsed = config as unknown as GoogleSheetsConfig;

    if (records.length === 0) {
      return { created: 0, updated: 0, skipped: 0, summary: 'No rows to append.' };
    }
    if (records.some((record) => Object.keys(record.values).length === 0)) {
      throw new Error('Google Sheets records must contain at least one field.');
    }
    // A failed header lookup is not proof that the sheet is empty: never overwrite on error.
    const schema = await this.describeSchema(config, context);
    let headers = schema.fields.map((field) => field.key);
    const initializeHeaders = headers.length === 0;
    if (initializeHeaders) headers = Object.keys(records[0]!.values);
    validateHeaders(headers);
    const unknown = records
      .flatMap((record) => Object.keys(record.values))
      .filter((key) => !headers.includes(key));
    if (unknown.length > 0) {
      throw new Error(`The sheet is missing these columns: ${[...new Set(unknown)].join(', ')}`);
    }
    if (initializeHeaders) {
      const headerResponse = await boundedFetch(
        context,
        this.url(
          parsed,
          `values/${encodeURIComponent(`${parsed.sheetName}!A1`)}?valueInputOption=RAW`,
        ),
        {
          method: 'PUT',
          headers: this.headers(parsed),
          body: JSON.stringify({ values: [headers] }),
        },
        parsed.timeoutMs,
      );
      if (!headerResponse.ok) {
        throw new Error(describeSheetsError(headerResponse.status, 'write the header row'));
      }
    }

    const values = records.map((record) => headers.map((header) => record.values[header] ?? ''));
    const response = await boundedFetch(
      context,
      this.url(
        parsed,
        `values/${encodeURIComponent(`${parsed.sheetName}!A1`)}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`,
      ),
      {
        method: 'POST',
        headers: this.headers(parsed),
        body: JSON.stringify({ values }),
      },
      parsed.timeoutMs,
    );
    if (!response.ok) {
      throw new Error(describeSheetsError(response.status, 'append rows'));
    }
    context.logger.info('google sheets connector appended rows', { rows: values.length });
    return {
      created: values.length,
      updated: 0,
      skipped: 0,
      summary: `appended ${values.length} row(s) to ${parsed.sheetName}`,
    };
  }

  async read(
    query: ConnectorReadQuery,
    config: Record<string, unknown>,
    context: ConnectorContext,
  ): Promise<ConnectorRecord[]> {
    this.validateConfig(config);
    const parsed = config as unknown as GoogleSheetsConfig;
    const response = await boundedFetch(
      context,
      this.url(parsed, `values/${encodeURIComponent(parsed.sheetName)}`),
      { headers: this.headers(parsed) },
      parsed.timeoutMs,
    );
    if (!response.ok) {
      throw new Error(describeSheetsError(response.status, 'read the sheet'));
    }
    const [header = [], ...rows] = parseSheetRows(response.text);
    validateHeaders(header);
    return rows
      .map((row) => Object.fromEntries(header.map((key, index) => [key, row[index] ?? null])))
      .filter((record) =>
        Object.entries(query.where ?? {}).every(
          ([key, value]) => String(record[key] ?? '') === String(value),
        ),
      )
      .slice(0, query.limit ?? 100)
      .map((values) => ({ values }));
  }
}

type SheetCell = string | number | boolean | null;

function parseSheetRows(text: string): SheetCell[][] {
  const payload: unknown = JSON.parse(text);
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('Google Sheets returned an invalid response.');
  }
  const data = payload as { range?: unknown; values?: unknown };
  if (data.values === undefined && typeof data.range === 'string' && data.range.length > 0)
    return [];
  if (
    !Array.isArray(data.values) ||
    data.values.some(
      (row: unknown) =>
        !Array.isArray(row) ||
        row.some(
          (cell: unknown) =>
            cell !== null &&
            typeof cell !== 'string' &&
            typeof cell !== 'boolean' &&
            !(typeof cell === 'number' && Number.isFinite(cell)),
        ),
    )
  ) {
    throw new Error('Google Sheets returned invalid rows.');
  }
  return data.values as SheetCell[][];
}

function validateHeaders(header: SheetCell[]): asserts header is string[] {
  if (
    header.some((key) => typeof key !== 'string' || key.trim() === '') ||
    new Set(header).size !== header.length
  ) {
    throw new Error('Google Sheets returned invalid or duplicate headers.');
  }
}

function describeSheetsError(status: number, action: string): string {
  if (status === 401) return 'Google authorization expired. Reconnect the connector.';
  if (status === 403) return 'Google denied access to that spreadsheet. Check sharing permissions.';
  if (status === 404) return `Could not ${action}: spreadsheet or sheet not found.`;
  if (status === 429) return 'Google Sheets rate limit reached. Try again shortly.';
  return `Could not ${action} (HTTP ${status}).`;
}
