import { lookup, type LookupAddress, type LookupOptions } from 'node:dns';
import type { LookupFunction } from 'node:net';
import * as ipaddr from 'ipaddr.js';
import { Agent } from 'undici';
import type { ConnectorContext } from '../contract';

/** Network addresses from all DNS answers must be public, not just the first answer. */
export function isPublicAddress(value: string): boolean {
  if (!ipaddr.isValid(value)) return false;
  const address = ipaddr.parse(value);
  if (address.range() !== 'unicast') return false;
  // Treat only the global-unicast IPv6 space as eligible; this excludes translation/tunnel,
  // mapped, link-local, multicast, documentation and other special-use ranges.
  if (address.kind() === 'ipv6') {
    return (address as ipaddr.IPv6).match(ipaddr.IPv6.parse('2000::'), 3);
  }
  return true;
}

type Resolver = (
  hostname: string,
  options: { all: true; verbatim: true },
  callback: (error: NodeJS.ErrnoException | null, addresses: LookupAddress[]) => void,
) => void;

/**
 * This lookup runs at socket connection time, not as a pre-flight DNS check. It returns only the
 * validated DNS answers directly to Node's connector, closing the DNS-rebinding TOCTOU gap. The
 * original hostname remains in the URL for TLS certificate validation and SNI.
 */
export function createGuardedLookup(resolve: Resolver = lookup): LookupFunction {
  return (hostname: string, options: LookupOptions, callback) => {
    resolve(hostname, { all: true, verbatim: true }, (error, addresses) => {
      if (error) return callback(error, '', 0);
      if (!addresses.length || addresses.some(({ address }) => !isPublicAddress(address))) {
        return callback(new Error('Connector DNS resolved to a non-public address.'), '', 0);
      }
      const family = options.family === 'IPv4' ? 4 : options.family === 'IPv6' ? 6 : options.family;
      const eligible = addresses.filter((address) => !family || address.family === family);
      if (!eligible.length)
        return callback(new Error('Connector DNS returned no usable address.'), '', 0);
      if (options.all) return callback(null, eligible);
      return callback(null, eligible[0]!.address, eligible[0]!.family);
    });
  };
}

// Connection pools reuse only sockets that have passed the lookup check. New connections resolve
// and validate again. No environment-controlled proxy is used by this dispatcher.
const dispatcher = new Agent({ connect: { lookup: createGuardedLookup() } });

/** fetchImpl is an internal test seam only; production callers must not inject an untrusted fetch. */
export function guardedFetch(
  context: ConnectorContext,
  url: string,
  init: RequestInit,
): Promise<Response> {
  const request = { ...init, redirect: 'error' as const };
  if (context.fetchImpl) return context.fetchImpl(url, request);
  // Node's fetch accepts an Undici-compatible dispatcher, but its bundled undici-types version
  // may differ structurally from the separately installed Agent's TypeScript declarations.
  return fetch(url, { ...request, dispatcher } as unknown as RequestInit);
}

const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_TIMEOUT_MS = 120_000;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

export function checkedTimeout(value: unknown): number {
  if (value === undefined) return DEFAULT_TIMEOUT_MS;
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < 1 ||
    value > MAX_TIMEOUT_MS
  ) {
    throw new Error('Connector timeoutMs must be an integer between 1 and 120000.');
  }
  return value;
}

export class BoundedFetchError extends Error {
  constructor(readonly reason: 'timeout' | 'size' | 'network') {
    super('Connector HTTP request failed.');
    this.name = 'BoundedFetchError';
  }
}

/** Bounds accumulated response bytes and the asynchronous fetch and body-read interval. */
export async function boundedFetch(
  context: ConnectorContext,
  url: string,
  init: Omit<RequestInit, 'signal'>,
  timeoutMs?: number,
): Promise<{ ok: boolean; status: number; text: string }> {
  const deadline = checkedTimeout(timeoutMs);
  const controller = new AbortController();
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
      if (reader) void reader.cancel().catch(() => undefined);
      reject(new BoundedFetchError('timeout'));
    }, deadline);
  });
  const request = async () => {
    const response = await guardedFetch(context, url, { ...init, signal: controller.signal });
    if (timedOut) {
      if (response.body) void response.body.cancel().catch(() => undefined);
      throw new BoundedFetchError('timeout');
    }
    reader = response.body?.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    if (reader) {
      while (true) {
        const chunk = await reader.read();
        if (timedOut) throw new BoundedFetchError('timeout');
        if (chunk.done) break;
        total += chunk.value.byteLength;
        if (total > MAX_RESPONSE_BYTES) throw new BoundedFetchError('size');
        chunks.push(chunk.value);
      }
    }
    return {
      ok: response.ok,
      status: response.status,
      text: Buffer.concat(chunks, total).toString('utf8'),
    };
  };
  try {
    return await Promise.race([request(), timeout]);
  } catch (error) {
    controller.abort();
    if (reader) void reader.cancel().catch(() => undefined);
    if (timedOut) throw new BoundedFetchError('timeout');
    if (error instanceof BoundedFetchError) throw error;
    throw new BoundedFetchError('network');
  } finally {
    if (timer) clearTimeout(timer);
  }
}
