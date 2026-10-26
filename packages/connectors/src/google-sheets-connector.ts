import type {
  Connector,
  ConnectorContext,
  ConnectorDestinationSchema,
  ConnectorReadQuery,
  ConnectorRecord,
  ConnectorWriteResult,
} from './contract';

/**
 * Google Sheets connector (CON-002).
 *
 * Talks to the Sheets v4 REST API with an OAuth access token supplied by the caller (refreshing
 * is the backend's job — tokens are stored encrypted there, never here). Appends respect existing
 * headers and never rewrite unrelated columns.
 */
export interface GoogleSheetsConfig {
  spreadsheetId: string;
  sheetName: string;
  /** OAuth bearer token, injected by the backend at run time. Never persisted in `config`. */
  accessToken?: string;
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
    const fetchImpl = context.fetchImpl ?? fetch;
    const response = await fetchImpl(
      this.url(parsed, `values/${encodeURIComponent(`${parsed.sheetName}!1:1`)}`),
      { headers: this.headers(parsed) },
    );
    if (!response.ok) {
      throw new Error(await describeSheetsError(response, 'read the header row'));
    }
    const payload = (await response.json()) as { values?: string[][] };
    const header = payload.values?.[0] ?? [];
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
    const fetchImpl = context.fetchImpl ?? fetch;

    // Discover existing headers so new columns never silently shift old data.
    let headers: string[] = [];
    try {
      const schema = await this.describeSchema(config, context);
      headers = schema.fields.map((field) => field.key);
    } catch {
      headers = [];
    }
    if (headers.length === 0) {
      headers = records.length > 0 ? Object.keys(records[0]!.values) : [];
      if (headers.length > 0) {
        const headerResponse = await fetchImpl(
          this.url(
            parsed,
            `values/${encodeURIComponent(`${parsed.sheetName}!A1`)}?valueInputOption=RAW`,
          ),
          {
            method: 'PUT',
            headers: this.headers(parsed),
            body: JSON.stringify({ values: [headers] }),
          },
        );
        if (!headerResponse.ok) {
          throw new Error(await describeSheetsError(headerResponse, 'write the header row'));
        }
      }
    }

    const unknown = records
      .flatMap((record) => Object.keys(record.values))
      .filter((key) => !headers.includes(key));
    if (unknown.length > 0) {
      throw new Error(`The sheet is missing these columns: ${[...new Set(unknown)].join(', ')}`);
    }

    const values = records.map((record) => headers.map((header) => record.values[header] ?? ''));
    const response = await fetchImpl(
      this.url(
        parsed,
        `values/${encodeURIComponent(`${parsed.sheetName}!A1`)}:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`,
      ),
      {
        method: 'POST',
        headers: this.headers(parsed),
        body: JSON.stringify({ values }),
      },
    );
    if (!response.ok) {
      throw new Error(await describeSheetsError(response, 'append rows'));
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
    const fetchImpl = context.fetchImpl ?? fetch;
    const response = await fetchImpl(
      this.url(parsed, `values/${encodeURIComponent(parsed.sheetName)}`),
      { headers: this.headers(parsed) },
    );
    if (!response.ok) {
      throw new Error(await describeSheetsError(response, 'read the sheet'));
    }
    const payload = (await response.json()) as { values?: string[][] };
    const [header = [], ...rows] = payload.values ?? [];
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

async function describeSheetsError(response: Response, action: string): Promise<string> {
  if (response.status === 401) return 'Google authorization expired. Reconnect the connector.';
  if (response.status === 403)
    return 'Google denied access to that spreadsheet. Check sharing permissions.';
  if (response.status === 404) return `Could not ${action}: spreadsheet or sheet not found.`;
  if (response.status === 429) return 'Google Sheets rate limit reached. Try again shortly.';
  return `Could not ${action} (HTTP ${response.status}).`;
}
