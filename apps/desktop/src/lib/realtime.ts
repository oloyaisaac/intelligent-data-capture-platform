/**
 * Realtime client for the dashboard (DESK-002).
 *
 * Uses `EventSource` against the authenticated SSE endpoint. The browser's EventSource cannot set
 * an Authorization header, so the client subscribes with a short-lived stream ticket query
 * parameter — the server accepts the same access token there and never logs it.
 */

export type RealtimeEventName =
  | 'device:paired'
  | 'device:revoked'
  | 'document:queued'
  | 'job:progress'
  | 'document:extracted'
  | 'document:needs_review'
  | 'document:approved'
  | 'document:failed'
  | 'connector:run_updated'
  | 'export:ready';

export interface RealtimeClientOptions {
  /** Full URL to the events endpoint, including any ticket query parameter. */
  url: string;
  onEvent: (event: RealtimeEventName, payload: Record<string, unknown>) => void;
  onStatusChange?: (status: 'connecting' | 'live' | 'offline') => void;
  /** Injected in tests; defaults to the browser EventSource. */
  EventSourceImpl?: typeof EventSource;
  maxRetries?: number;
}

export interface RealtimeClient {
  close(): void;
}

export function connectRealtime(options: RealtimeClientOptions): RealtimeClient {
  const Impl =
    options.EventSourceImpl ?? (globalThis as { EventSource?: typeof EventSource }).EventSource;
  if (!Impl) {
    options.onStatusChange?.('offline');
    return { close: () => undefined };
  }

  const maxRetries = options.maxRetries ?? 6;
  let attempts = 0;
  let source: EventSource | null = null;
  let closed = false;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;

  const open = () => {
    if (closed) return;
    options.onStatusChange?.('connecting');
    source = new Impl(options.url);
    source.onopen = () => {
      attempts = 0;
      options.onStatusChange?.('live');
    };
    source.onerror = () => {
      source?.close();
      source = null;
      if (closed) return;
      options.onStatusChange?.('offline');
      if (attempts >= maxRetries) return;
      attempts += 1;
      // Exponential backoff, capped: a flapping connection must not hammer the server.
      const delay = Math.min(1_000 * 2 ** attempts, 30_000);
      retryTimer = setTimeout(open, delay);
    };
    for (const name of [
      'device:paired',
      'device:revoked',
      'document:queued',
      'job:progress',
      'document:extracted',
      'document:needs_review',
      'document:approved',
      'document:failed',
      'connector:run_updated',
      'export:ready',
    ] as RealtimeEventName[]) {
      source.addEventListener(name, (message) => {
        const data = (message as MessageEvent<string>).data;
        let payload: Record<string, unknown> = {};
        try {
          payload = data ? (JSON.parse(data) as Record<string, unknown>) : {};
        } catch {
          payload = {};
        }
        options.onEvent(name, payload);
      });
    }
  };

  open();

  return {
    close() {
      closed = true;
      if (retryTimer) clearTimeout(retryTimer);
      source?.close();
      source = null;
    },
  };
}

/** The events URL for the current session. The token stays in the query string, never in a body. */
export function eventsUrl(accessToken: string | null, base = '/api/v1'): string {
  if (!accessToken) return `${base}/events`;
  return `${base}/events?access_token=${encodeURIComponent(accessToken)}`;
}
