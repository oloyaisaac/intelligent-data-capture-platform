/**
 * Shared plumbing for the first-party CRM/ERP/accounting connectors (CRM-001).
 *
 * These destinations are all "HTTP + JSON with an opinionated error body", so the transport,
 * validation and error translation live here once. Each connector then only describes its vendor's
 * object paths and payload shape — which is also the part field mapping must not need to know about.
 */
import { isIP } from 'node:net';
import type { ConnectorContext, ConnectorRecord } from '../contract';
import { boundedFetch, BoundedFetchError, checkedTimeout } from './safe-http';

export interface HttpConfig {
  baseUrl: string;
  token: string;
  object: string;
  idField: string;
  /** Milliseconds before a request is abandoned; keeps a run from hanging the worker. */
  timeoutMs?: number;
}

export class ConnectorRequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly vendorCode: string | null = null,
  ) {
    super(message);
    this.name = 'ConnectorRequestError';
  }
}

export function requireString(config: Record<string, unknown>, key: string, hint: string): string {
  const value = config[key];
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${key} is required. ${hint}`);
  }
  return value.trim();
}

/** Only HTTPS DNS names are supported. DNS answers are validated again at connection time. */
export function validateBaseUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('baseUrl must be an absolute URL, for example https://api.hubapi.com.');
  }
  if (url.protocol !== 'https:') throw new Error('baseUrl must use https.');
  const hostname = url.hostname
    .replace(/\.$/, '')
    .replace(/^\[|\]$/g, '')
    .toLowerCase();
  if (isIP(hostname) || !hostname.includes('.') || hostname.endsWith('.localhost')) {
    throw new Error('baseUrl must use a public DNS hostname, not an IP address or localhost.');
  }
  if (url.username || url.password || url.href.includes('?') || url.href.includes('#')) {
    throw new Error('baseUrl must not contain credentials, a query string, or a fragment.');
  }
  return url.toString().replace(/\/$/, '');
}

export function readHttpConfig(
  config: Record<string, unknown>,
  defaults: { baseUrl: string; object: string; idField?: string },
): HttpConfig {
  const baseUrl = validateBaseUrl(
    typeof config.baseUrl === 'string' && config.baseUrl
      ? config.baseUrl
      : (defaults.baseUrl ?? ''),
  );
  return {
    baseUrl,
    token: requireString(config, 'token', 'Create a private app token with write access.'),
    object: typeof config.object === 'string' && config.object ? config.object : defaults.object,
    idField:
      typeof config.idField === 'string' && config.idField
        ? config.idField
        : (defaults.idField ?? 'id'),
    timeoutMs: checkedTimeout(config.timeoutMs),
  };
}

export interface JsonResponse {
  status: number;
  body: unknown;
}

export async function jsonRequest(
  context: ConnectorContext,
  config: HttpConfig,
  path: string,
  init: { method: string; body?: unknown; headers?: Record<string, string> },
  vendor: string,
): Promise<JsonResponse> {
  const baseUrl = validateBaseUrl(config.baseUrl);
  const timeoutMs = checkedTimeout(config.timeoutMs);
  let response: Awaited<ReturnType<typeof boundedFetch>>;
  try {
    response = await boundedFetch(
      context,
      `${baseUrl}${path}`,
      {
        method: init.method,
        headers: {
          accept: 'application/json',
          ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
          authorization: `Bearer ${config.token}`,
          ...init.headers,
        },
        ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
      },
      timeoutMs,
    );
  } catch (error) {
    if (error instanceof BoundedFetchError && error.reason === 'timeout') {
      throw new ConnectorRequestError(`${vendor} request timed out.`, 0);
    }
    if (error instanceof BoundedFetchError && error.reason === 'size') {
      throw new ConnectorRequestError(`${vendor} response exceeded the size limit.`, 0);
    }
    throw new ConnectorRequestError(
      `Could not complete the ${vendor} request. Check the connection and network.`,
      0,
    );
  }
  const body = response.text ? safeJson(response.text) : null;
  if (!response.ok) {
    throw new ConnectorRequestError(
      translateError(vendor, response.status, body),
      response.status,
      vendorCode(body),
    );
  }
  return { status: response.status, body };
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

function vendorCode(body: unknown): string | null {
  if (typeof body !== 'object' || body === null) return null;
  const record = body as Record<string, unknown>;
  const candidates = [record.category, record.status, record.errorCode, record.code];
  for (const candidate of candidates) {
    if (typeof candidate === 'string') return candidate;
    if (typeof candidate === 'number') return String(candidate);
  }
  if (typeof record.error === 'object' && record.error !== null) {
    const nested = record.error as Record<string, unknown>;
    if (typeof nested.code === 'string') return nested.code;
  }
  return null;
}

/**
 * Turns a vendor error into something a person can act on.
 *
 * The rule: name the fix, not the HTTP status. "401" tells a user nothing; "the token is missing the
 * write scope" tells them what to change.
 */
export function translateError(vendor: string, status: number, body: unknown): string {
  const detail = describeBody(body);
  if (status === 401 || status === 403) {
    return `${vendor} rejected the credential. Create a token with write access to this object and paste it again${detail ? ` (${detail})` : ''}.`;
  }
  if (status === 404) {
    return `${vendor} has no such object or record. Check the object name in the mapping profile${detail ? ` (${detail})` : ''}.`;
  }
  if (status === 429) {
    return `${vendor} is rate limiting this connection. The run has been recorded; retry it in a few minutes.`;
  }
  if (status === 400 || status === 422) {
    return `${vendor} refused the record: ${detail || 'a field did not validate'}. Check the mapping profile against the destination schema.`;
  }
  if (status >= 500) {
    return `${vendor} returned a server error (${status}). This is on their side; retry later.`;
  }
  return `${vendor} rejected the request (${status})${detail ? `: ${detail}` : ''}.`;
}

function describeBody(body: unknown): string {
  if (body === null || body === undefined) return '';
  if (typeof body === 'string') return body.slice(0, 200);
  if (typeof body !== 'object') return String(body);

  const record = body as Record<string, unknown>;
  const messages: string[] = [];
  const push = (value: unknown) => {
    if (typeof value === 'string' && value.trim()) messages.push(value.trim());
  };
  push(record.message);
  push(record.error_description);
  push(record.error);
  push(record.detail);
  if (Array.isArray(record.errors)) {
    for (const error of record.errors) {
      if (typeof error === 'string') push(error);
      else if (typeof error === 'object' && error !== null) {
        push((error as Record<string, unknown>).detail);
        push((error as Record<string, unknown>).message);
      }
    }
  }
  return messages.slice(0, 3).join('; ').slice(0, 300);
}

/** Filters a destination payload down to the fields the vendor accepts. */
export function presentValues(
  values: ConnectorRecord['values'],
  keep: (key: string, value: unknown) => boolean = (_key, value) => value !== null,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(values)) {
    if (keep(key, value)) out[key] = value;
  }
  return out;
}

/** Destination schema derived from the record the caller is about to send. */
export function schemaFromRecord(
  object: string,
  sample: ConnectorRecord['values'],
): { container: string; fields: Array<{ key: string; label: string; type: 'string' }> } {
  return {
    container: object,
    fields: Object.keys(sample)
      .sort()
      .map((key) => ({ key, label: key, type: 'string' as const })),
  };
}
