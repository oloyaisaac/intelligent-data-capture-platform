/**
 * HubSpot CRM (CRM-001).
 *
 * HubSpot keeps object properties behind a `properties` envelope, and its search endpoint takes
 * structured filters rather than query strings — both facts live here so a mapping profile only ever
 * deals with field names.
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
  type HttpConfig,
} from './http';

interface HubSpotFilter {
  propertyName: string;
  operator: 'EQ';
  value: string;
}

export class HubSpotConnector implements Connector {
  readonly type = 'hubspot';
  readonly label = 'HubSpot CRM';
  readonly capabilities = ['create', 'read', 'update', 'search'] as const;

  private config(config: Record<string, unknown>): HttpConfig {
    return readHttpConfig(config, { baseUrl: 'https://api.hubapi.com', object: 'contacts' });
  }

  validateConfig(config: Record<string, unknown>): void {
    const resolved = this.config(config);
    if (!/^[a-z][a-z0-9_]*$/.test(resolved.object)) {
      throw new Error('object must be a HubSpot object name, for example contacts or deals.');
    }
  }

  async describeSchema(
    config: Record<string, unknown>,
    context: ConnectorContext,
  ): Promise<ConnectorDestinationSchema> {
    const resolved = this.config(config);
    const { body } = await jsonRequest(
      context,
      resolved,
      `/crm/v3/properties/${resolved.object}`,
      { method: 'GET' },
      'HubSpot',
    );
    const results = (body as { results?: Array<{ name?: string; label?: string }> }).results ?? [];
    return {
      container: resolved.object,
      fields: results
        .filter((property): property is { name: string; label?: string } => Boolean(property.name))
        .map((property) => ({
          key: property.name,
          label: property.label ?? property.name,
          type: 'string' as const,
        })),
    };
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
        `/crm/v3/objects/${resolved.object}?limit=1`,
        { method: 'GET' },
        'HubSpot',
      );
      return { ok: true };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : 'HubSpot check failed.' };
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
        `/crm/v3/objects/${resolved.object}`,
        { method: 'POST', body: { properties: stringify(record.values) } },
        'HubSpot',
      );
      created += 1;
    }
    return {
      created,
      updated: 0,
      skipped: 0,
      summary: `Created ${created} ${resolved.object} record(s) in HubSpot.`,
    };
  }

  async read(
    query: ConnectorReadQuery,
    config: Record<string, unknown>,
    context: ConnectorContext,
  ): Promise<ConnectorRecord[]> {
    const resolved = this.config(config);
    const limit = Math.min(query.limit ?? 20, 100);
    const { body } = await jsonRequest(
      context,
      resolved,
      `/crm/v3/objects/${resolved.object}?limit=${limit}`,
      { method: 'GET' },
      'HubSpot',
    );
    return toRecords(body);
  }

  async search(
    query: ConnectorReadQuery,
    config: Record<string, unknown>,
    context: ConnectorContext,
  ): Promise<ConnectorRecord[]> {
    const resolved = this.config(config);
    const filters: HubSpotFilter[] = Object.entries(query.where ?? {}).map(
      ([propertyName, value]) => ({
        propertyName,
        operator: 'EQ',
        value: String(value),
      }),
    );
    if (filters.length === 0) return this.read(query, config, context);

    const { body } = await jsonRequest(
      context,
      resolved,
      `/crm/v3/objects/${resolved.object}/search`,
      {
        method: 'POST',
        body: { filterGroups: [{ filters }], limit: Math.min(query.limit ?? 20, 100) },
      },
      'HubSpot',
    );
    return toRecords(body);
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
    for (const record of records) {
      const id = record.values[key] ?? record.values[resolved.idField];
      if (id === null || id === undefined) {
        throw new ConnectorRequestError(
          `HubSpot needs "${key}" to update a record. Add it to the mapping profile.`,
          0,
        );
      }
      await jsonRequest(
        context,
        resolved,
        `/crm/v3/objects/${resolved.object}/${encodeURIComponent(String(id))}`,
        { method: 'PATCH', body: { properties: stringify(record.values) } },
        'HubSpot',
      );
      updated += 1;
    }
    return {
      created: 0,
      updated,
      skipped: 0,
      summary: `Updated ${updated} ${resolved.object} record(s) in HubSpot.`,
    };
  }
}

function stringify(values: ConnectorRecord['values']): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(presentValues(values))) {
    out[key] = String(value);
  }
  return out;
}

function toRecords(body: unknown): ConnectorRecord[] {
  const results = (
    body as { results?: Array<{ id?: string; properties?: Record<string, unknown> }> }
  ).results;
  if (!Array.isArray(results)) return [];
  return results.map((entry) => ({
    // The top-level object ID addresses PATCH; a property named id must not replace it.
    values: { ...(entry.properties ?? {}), id: entry.id ?? null },
  }));
}
