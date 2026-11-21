/**
 * QuickBooks Online (CRM-001 — the accounting destination).
 *
 * QuickBooks has no REST object search: reads go through its `query` endpoint (a SQL subset), and
 * updates are a full POST with `sparse: true`. Both quirks stay in this file.
 */
import type {
  Connector,
  ConnectorContext,
  ConnectorDestinationSchema,
  ConnectorReadQuery,
  ConnectorRecord,
  ConnectorWriteResult,
} from '../contract';
import {
  ConnectorRequestError,
  jsonRequest,
  presentValues,
  readHttpConfig,
  schemaFromRecord,
  validateBaseUrl,
  type HttpConfig,
} from './http';

interface QuickBooksConfig extends HttpConfig {
  realmId: string;
}

const DEFAULT_BASE = 'https://quickbooks.api.intuit.com';

export class QuickBooksConnector implements Connector {
  readonly type = 'quickbooks';
  readonly label = 'QuickBooks Online';
  readonly capabilities = ['create', 'read', 'update', 'search'] as const;

  private config(config: Record<string, unknown>): QuickBooksConfig {
    const base = readHttpConfig(config, { baseUrl: DEFAULT_BASE, object: 'Invoice' });
    if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(base.object)) {
      throw new Error('object must be a QuickBooks entity name, for example Invoice or Customer.');
    }
    const realmId = config.realmId;
    if (typeof realmId !== 'string' || realmId.trim() === '') {
      throw new Error(
        'realmId is required. It is the company id in the QuickBooks URL after /company/.',
      );
    }
    return { ...base, realmId: realmId.trim() };
  }

  private path(config: QuickBooksConfig, suffix: string): string {
    return `/v3/company/${encodeURIComponent(config.realmId)}${suffix}`;
  }

  validateConfig(config: Record<string, unknown>): void {
    const resolved = this.config(config);
    validateBaseUrl(resolved.baseUrl);
  }

  async describeSchema(
    config: Record<string, unknown>,
    context: ConnectorContext,
  ): Promise<ConnectorDestinationSchema> {
    const resolved = this.config(config);
    const { body } = await jsonRequest(
      context,
      resolved,
      this.path(
        resolved,
        `/query?query=${encodeURIComponent(`select * from ${resolved.object} maxresults 1`)}`,
      ),
      { method: 'GET' },
      'QuickBooks',
    );
    const sample = firstEntity(body);
    return schemaFromRecord(resolved.object, sample ?? {});
  }

  async healthCheck(
    config: Record<string, unknown>,
    context: ConnectorContext,
  ): Promise<{ ok: boolean; error?: string }> {
    try {
      const resolved = this.config(config);
      await jsonRequest(
        context,
        resolved,
        this.path(
          resolved,
          `/query?query=${encodeURIComponent(`select * from ${resolved.object} maxresults 1`)}`,
        ),
        { method: 'GET' },
        'QuickBooks',
      );
      return { ok: true };
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : 'QuickBooks check failed.',
      };
    }
  }

  async create(
    records: ConnectorRecord[],
    config: Record<string, unknown>,
    context: ConnectorContext,
  ): Promise<ConnectorWriteResult> {
    const resolved = this.config(config);
    let created = 0;
    for (const record of records) {
      await jsonRequest(
        context,
        resolved,
        this.path(resolved, `/${resolved.object}`),
        { method: 'POST', body: presentValues(record.values) },
        'QuickBooks',
      );
      created += 1;
    }
    return {
      created,
      updated: 0,
      skipped: 0,
      summary: `Created ${created} ${resolved.object} record(s) in QuickBooks.`,
    };
  }

  async read(
    query: ConnectorReadQuery,
    config: Record<string, unknown>,
    context: ConnectorContext,
  ): Promise<ConnectorRecord[]> {
    return this.runQuery(
      `select * from ${this.config(config).object}`,
      query.limit,
      config,
      context,
    );
  }

  async search(
    query: ConnectorReadQuery,
    config: Record<string, unknown>,
    context: ConnectorContext,
  ): Promise<ConnectorRecord[]> {
    const resolved = this.config(config);
    const clauses = Object.entries(query.where ?? {}).map(([field, value]) => {
      if (!/^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)*$/.test(field)) {
        throw new Error('QuickBooks filter field must be a simple or dotted identifier.');
      }
      return `${field} = ${queryLiteral(value)}`;
    });
    const sql = `select * from ${resolved.object}${clauses.length > 0 ? ` where ${clauses.join(' and ')}` : ''}`;
    return this.runQuery(sql, query.limit, config, context);
  }

  private async runQuery(
    sql: string,
    limit: number | undefined,
    config: Record<string, unknown>,
    context: ConnectorContext,
  ): Promise<ConnectorRecord[]> {
    const resolved = this.config(config);
    if (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 1)) {
      throw new Error('QuickBooks query limit must be a positive integer.');
    }
    const bounded = `${sql} maxresults ${Math.min(limit ?? 100, 100)}`;
    const { body } = await jsonRequest(
      context,
      resolved,
      this.path(resolved, `/query?query=${encodeURIComponent(bounded)}`),
      { method: 'GET' },
      'QuickBooks',
    );
    return flattenEntities(body);
  }

  async update(
    records: ConnectorRecord[],
    keys: string[],
    config: Record<string, unknown>,
    context: ConnectorContext,
  ): Promise<ConnectorWriteResult> {
    const resolved = this.config(config);
    const key = keys[0] ?? 'Id';
    let updated = 0;
    for (const record of records) {
      const id = record.values[key] ?? record.values.Id;
      if (id === null || id === undefined) {
        throw new ConnectorRequestError(
          `QuickBooks needs "${key}" (or Id) to update a record. Add it to the mapping profile.`,
          0,
        );
      }
      await jsonRequest(
        context,
        resolved,
        this.path(resolved, `/${resolved.object}`),
        { method: 'POST', body: { ...presentValues(record.values), Id: String(id), sparse: true } },
        'QuickBooks',
      );
      updated += 1;
    }
    return {
      created: 0,
      updated,
      skipped: 0,
      summary: `Updated ${updated} ${resolved.object} record(s) in QuickBooks.`,
    };
  }
}

/** QuickBooks returns `{ QueryResponse: { Invoice: [ ... ] } }`; the key is the entity name. */
function flattenEntities(body: unknown): ConnectorRecord[] {
  const response = (body as { QueryResponse?: Record<string, unknown> }).QueryResponse;
  if (!response) return [];
  for (const value of Object.values(response)) {
    if (Array.isArray(value)) {
      return value.map((entry) => ({ values: entry as ConnectorRecord['values'] }));
    }
  }
  return [];
}

function firstEntity(body: unknown): ConnectorRecord['values'] | null {
  const records = flattenEntities(body);
  return records[0]?.values ?? null;
}

/** The QuickBooks query API has no bind parameters. Reject ambiguous escape/control input. */
function queryLiteral(value: string | number | boolean): string {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('QuickBooks filter number must be finite.');
    return String(value);
  }
  if (typeof value === 'boolean') return String(value);
  if (
    typeof value !== 'string' ||
    value.includes('\\') ||
    Array.from(value).some((character) => {
      const code = character.charCodeAt(0);
      return code < 32 || code === 127;
    })
  ) {
    throw new Error('QuickBooks filter value contains unsupported characters.');
  }
  return `'${value.replace(/'/g, "\\'")}'`;
}
