/**
 * Odoo ERP (CRM-001 — the ERP destination).
 *
 * Odoo speaks JSON-RPC, not REST: one endpoint, a method name, positional arguments and a keyword
 * map. Authentication returns a `uid` that every later call needs. Each public operation
 * authenticates afresh and reuses the id only within that operation.
 *
 * Field names are Odoo's (`partner_id`, `invoice_date`, …), and the mapping profile is where those
 * are chosen — no code change is needed to retarget a different model.
 */
import type {
  Connector,
  ConnectorContext,
  ConnectorDestinationSchema,
  ConnectorReadQuery,
  ConnectorRecord,
  ConnectorWriteResult,
} from '../contract';
import { requireString, validateBaseUrl } from './http';
import { guardedFetch } from './safe-http';

interface OdooConfig {
  baseUrl: string;
  database: string;
  username: string;
  apiKey: string;
  model: string;
  idField: string;
}

interface JsonRpcResponse {
  result?: unknown;
  error?: { message?: string; data?: { message?: string } };
}

export class OdooConnector implements Connector {
  readonly type = 'odoo';
  readonly label = 'Odoo ERP';
  readonly capabilities = ['create', 'read', 'update', 'search'] as const;

  private config(config: Record<string, unknown>): OdooConfig {
    return {
      baseUrl: validateBaseUrl(
        typeof config.baseUrl === 'string' && config.baseUrl
          ? config.baseUrl
          : 'https://your-odoo.example.com',
      ),
      database: requireString(
        config,
        'database',
        'It is the database name shown in Odoo settings.',
      ),
      username: requireString(config, 'username', 'Use the integration user, not a person.'),
      apiKey: requireString(config, 'apiKey', 'Create an API key in the user preferences.'),
      model: typeof config.model === 'string' && config.model ? config.model : 'account.move',
      idField: typeof config.idField === 'string' && config.idField ? config.idField : 'id',
    };
  }

  validateConfig(config: Record<string, unknown>): void {
    const resolved = this.config(config);
    if (!/^[a-z][a-z0-9_.]*$/.test(resolved.model)) {
      throw new Error('model must be an Odoo model name, for example account.move or res.partner.');
    }
  }

  private async call(
    context: ConnectorContext,
    config: OdooConfig,
    service: 'common' | 'object',
    method: string,
    args: unknown[],
    kwargs: Record<string, unknown> = {},
  ): Promise<unknown> {
    const response = await guardedFetch(context, `${config.baseUrl}/jsonrpc`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        method: 'call',
        params: { service, method, args, kwargs },
        id: Date.now(),
      }),
    });

    if (response.status === 401 || response.status === 403) {
      throw new Error(
        'Odoo rejected the API key. Create a key for the integration user in Preferences → Account Security and paste it again.',
      );
    }
    if (!response.ok) {
      throw new Error(
        `Odoo returned ${response.status}. Check that ${config.baseUrl} is the server URL.`,
      );
    }

    const body = (await response.json()) as JsonRpcResponse;
    if (body.error) {
      const detail = body.error.data?.message ?? body.error.message ?? 'unknown error';
      throw new Error(
        `Odoo refused the operation on ${config.model}: ${detail}. Check the model and field names in the mapping profile.`,
      );
    }
    return body.result;
  }

  private async authenticate(context: ConnectorContext, config: OdooConfig): Promise<number> {
    const uid = await this.call(context, config, 'common', 'login', [
      config.database,
      config.username,
      config.apiKey,
    ]);
    if (typeof uid !== 'number') {
      throw new Error('Odoo refused the credentials. Check the database name and the API key.');
    }
    return uid;
  }

  private async execute(
    context: ConnectorContext,
    config: OdooConfig,
    method: string,
    args: unknown[],
    kwargs: Record<string, unknown> = {},
    operationUid?: number,
  ): Promise<unknown> {
    const uid = operationUid ?? (await this.authenticate(context, config));
    return this.call(
      context,
      config,
      'object',
      'execute_kw',
      [config.database, uid, config.apiKey, config.model, method, args, kwargs],
      {},
    );
  }

  async describeSchema(
    config: Record<string, unknown>,
    context: ConnectorContext,
  ): Promise<ConnectorDestinationSchema> {
    const resolved = this.config(config);
    const fields = (await this.execute(context, resolved, 'fields_get', [], {
      attributes: ['string', 'type', 'required'],
    })) as Record<string, { string?: string; type?: string; required?: boolean }>;

    return {
      container: resolved.model,
      fields: Object.entries(fields ?? {}).map(([key, meta]) => ({
        key,
        label: meta.string ?? key,
        type: normalizeType(meta.type),
        required: Boolean(meta.required),
      })),
    };
  }

  async healthCheck(
    config: Record<string, unknown>,
    context: ConnectorContext,
  ): Promise<{ ok: boolean; error?: string }> {
    try {
      const resolved = this.config(config);
      await this.execute(context, resolved, 'search_count', [[]]);
      return { ok: true };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : 'Odoo check failed.' };
    }
  }

  async create(
    records: ConnectorRecord[],
    config: Record<string, unknown>,
    context: ConnectorContext,
  ): Promise<ConnectorWriteResult> {
    const resolved = this.config(config);
    let created = 0;
    let uid: number | undefined;
    for (const record of records) {
      uid ??= await this.authenticate(context, resolved);
      const id = await this.execute(
        context,
        resolved,
        'create',
        [stripNulls(record.values)],
        {},
        uid,
      );
      if (typeof id !== 'number') {
        throw new Error(`Odoo did not return an id for a ${resolved.model} record.`);
      }
      created += 1;
    }
    return {
      created,
      updated: 0,
      skipped: 0,
      summary: `Created ${created} ${resolved.model} record(s) in Odoo.`,
    };
  }

  async read(
    query: ConnectorReadQuery,
    config: Record<string, unknown>,
    context: ConnectorContext,
  ): Promise<ConnectorRecord[]> {
    const resolved = this.config(config);
    const result = (await this.execute(context, resolved, 'search_read', [[]], {
      limit: Math.min(query.limit ?? 20, 100),
    })) as Array<Record<string, unknown>>;
    return (result ?? []).map((entry) => ({ values: entry as ConnectorRecord['values'] }));
  }

  async search(
    query: ConnectorReadQuery,
    config: Record<string, unknown>,
    context: ConnectorContext,
  ): Promise<ConnectorRecord[]> {
    const resolved = this.config(config);
    const domain = Object.entries(query.where ?? {}).map(([field, value]) => [field, '=', value]);
    const result = (await this.execute(context, resolved, 'search_read', [domain], {
      limit: Math.min(query.limit ?? 20, 100),
    })) as Array<Record<string, unknown>>;
    return (result ?? []).map((entry) => ({ values: entry as ConnectorRecord['values'] }));
  }

  async update(
    records: ConnectorRecord[],
    keys: string[],
    config: Record<string, unknown>,
    context: ConnectorContext,
  ): Promise<ConnectorWriteResult> {
    const resolved = this.config(config);
    const key = keys[0] ?? resolved.idField;
    let updated = 0;
    let uid: number | undefined;
    for (const record of records) {
      const id = record.values[key] ?? record.values[resolved.idField];
      if (id === null || id === undefined) {
        throw new Error(`Odoo needs "${key}" to update a record. Add it to the mapping profile.`);
      }
      uid ??= await this.authenticate(context, resolved);
      await this.execute(
        context,
        resolved,
        'write',
        [[Number(id)], stripNulls(record.values)],
        {},
        uid,
      );
      updated += 1;
    }
    return {
      created: 0,
      updated,
      skipped: 0,
      summary: `Updated ${updated} ${resolved.model} record(s) in Odoo.`,
    };
  }
}

function stripNulls(values: ConnectorRecord['values']): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(values)) {
    if (value !== null) out[key] = value;
  }
  return out;
}

function normalizeType(type: string | undefined): 'string' | 'number' | 'date' | 'boolean' {
  if (type === 'integer' || type === 'float' || type === 'monetary') return 'number';
  if (type === 'date' || type === 'datetime') return 'date';
  if (type === 'boolean') return 'boolean';
  return 'string';
}
