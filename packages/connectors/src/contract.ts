import { z } from 'zod';
import { parseDocumentDate, type DocumentType } from '@idcp/shared';

/**
 * Connector contract (CON-001 / DEC-004).
 *
 * A connector only ever receives UDM-shaped records with a mapping applied. It must declare what
 * it can do, describe its destination schema, and expose a health check. The standard backend
 * registry runs first-party operations in a one-shot subprocess; injected registries may run
 * in-process. The subprocess is not a security sandbox and cannot prevent malicious connector
 * code from compromising or terminating the host.
 */

export const CONNECTOR_CAPABILITIES = ['create', 'read', 'update', 'search'] as const;
export type ConnectorCapability = (typeof CONNECTOR_CAPABILITIES)[number];

export interface ConnectorDestinationField {
  key: string;
  label: string;
  type: 'string' | 'number' | 'date' | 'boolean';
  required?: boolean;
}

export interface ConnectorDestinationSchema {
  /** For SQL and Sheets this is the table/sheet name; for flat files, the file name. */
  container: string;
  fields: ConnectorDestinationField[];
}

export interface ConnectorRecord {
  /** Destination-shaped key/value pairs, already transformed by the mapping profile. */
  values: Record<string, string | number | boolean | null>;
}

export interface ConnectorReadQuery {
  limit?: number;
  /** Exact-match filters on destination fields. */
  where?: Record<string, string | number | boolean>;
}

export interface ConnectorWriteResult {
  created: number;
  updated: number;
  skipped: number;
  /** Human-readable summary stored on the run record (never contains document content). */
  summary: string;
}

export interface ConnectorContext {
  organisationId: string;
  logger: {
    info(message: string, context?: Record<string, unknown>): void;
    warn(message: string, context?: Record<string, unknown>): void;
    debug(message: string, context?: Record<string, unknown>): void;
    error(message: string, context?: Record<string, unknown>): void;
  };
  /** Injected for tests; connectors must not reach for globals. */
  fetchImpl?: typeof fetch;
}

export interface Connector {
  readonly type: string;
  readonly label: string;
  readonly capabilities: readonly ConnectorCapability[];
  /** Validate configuration at creation time; throws with an actionable message. */
  validateConfig(config: Record<string, unknown>): void;
  describeSchema(
    config: Record<string, unknown>,
    context: ConnectorContext,
  ): Promise<ConnectorDestinationSchema>;
  healthCheck(
    config: Record<string, unknown>,
    context: ConnectorContext,
  ): Promise<{ ok: boolean; error?: string }>;
  create(
    records: ConnectorRecord[],
    config: Record<string, unknown>,
    context: ConnectorContext,
  ): Promise<ConnectorWriteResult>;
  read?(
    query: ConnectorReadQuery,
    config: Record<string, unknown>,
    context: ConnectorContext,
  ): Promise<ConnectorRecord[]>;
  /**
   * Vendor-side search (CRM-001). Where `read` lists records, `search` is how a destination with a
   * query API (HubSpot's search endpoint, QuickBooks' `query`, Odoo's domain) answers "do you
   * already have this one?" without fetching a page and filtering in memory.
   */
  search?(
    query: ConnectorReadQuery,
    config: Record<string, unknown>,
    context: ConnectorContext,
  ): Promise<ConnectorRecord[]>;
  /**
   * Update the rows identified by `keys` (DUP-001). Connectors without it cannot honour an
   * `update` or `merge` duplicate policy, and the caller says so instead of writing twice.
   */
  update?(
    records: ConnectorRecord[],
    keys: string[],
    config: Record<string, unknown>,
    context: ConnectorContext,
  ): Promise<ConnectorWriteResult>;
}

/** Transform vocabulary shared with the mapping UI (MAP-001). */
export const TRANSFORMS = ['none', 'date_iso', 'number', 'boolean', 'uppercase', 'trim'] as const;
export type Transform = (typeof TRANSFORMS)[number];

export const MappedFieldSchema = z.object({
  udmPath: z.string().min(1),
  destinationField: z.string().min(1),
  transform: z.enum(TRANSFORMS).default('none'),
  defaultValue: z.union([z.string(), z.number(), z.boolean()]).optional(),
  required: z.boolean().default(false),
});
/** Input shape: `transform` and `required` are optional and normalised during apply. */
export type MappedField = z.input<typeof MappedFieldSchema>;

export interface AppliedMapping {
  values: Record<string, string | number | boolean | null>;
  /** Destination fields that were required but could not be filled. */
  missingRequired: string[];
}

/**
 * Apply a mapping profile to a UDM record.
 *
 * `udmFields` is a flat path → value map (e.g. `total.amount`). Transforms are deterministic and
 * total: an unparseable value becomes null rather than a guess, and required-but-empty fields are
 * reported so the caller can block the write instead of writing a half-empty row.
 */
export function applyMapping(
  fields: Record<string, unknown>,
  mapped: MappedField[],
  documentType?: DocumentType,
): AppliedMapping {
  void documentType;
  const values: Record<string, string | number | boolean | null> = {};
  const missingRequired: string[] = [];

  for (const field of mapped) {
    const raw = fields[field.udmPath];
    const fallback = field.defaultValue ?? null;
    const source = raw === undefined || raw === null || raw === '' ? fallback : raw;

    if (source === null || source === undefined || source === '') {
      if (field.required) missingRequired.push(field.destinationField);
      values[field.destinationField] = null;
      continue;
    }

    values[field.destinationField] = transformValue(source, field.transform ?? 'none');
  }

  return { values, missingRequired };
}

export function transformValue(
  value: unknown,
  transform: Transform,
): string | number | boolean | null {
  switch (transform) {
    case 'none':
      if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
        return value;
      }
      return value === null || value === undefined ? null : String(value);

    case 'trim':
      return String(value).trim();

    case 'uppercase':
      return String(value).trim().toUpperCase();

    case 'number': {
      if (typeof value === 'number') return Number.isFinite(value) ? value : null;
      const digits = String(value).replace(/[^\d.-]/g, '');
      // '' would coerce to 0 — refuse rather than invent a zero.
      if (!/\d/.test(digits)) return null;
      const numeric = Number(digits);
      return Number.isFinite(numeric) ? numeric : null;
    }

    case 'boolean': {
      if (typeof value === 'boolean') return value;
      const normalised = String(value).trim().toLowerCase();
      if (['true', 'yes', 'y', '1'].includes(normalised)) return true;
      if (['false', 'no', 'n', '0'].includes(normalised)) return false;
      return null;
    }

    case 'date_iso': {
      const text = String(value).trim();
      if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return text;
      // Reuse the document date parser so `26/10/2026` becomes 2026-10-26, and anything
      // ambiguous or unreadable becomes null rather than a wrong date.
      const parsed = parseDocumentDate(text);
      return parsed ? parsed.iso : null;
    }

    default:
      return null;
  }
}
