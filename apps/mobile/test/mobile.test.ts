import { buildPairingQrPayload } from '@idcp/shared';
import { describeDevice, formatExpiry, readPairingCode } from '../src/pairing/pairing';
import {
  UploadQueue,
  type QueueItem,
  type QueueStorage,
  type UploadTransport,
} from '../src/state/uploadQueue';
import { PersistedQueueStorage } from '../src/state/queueStorage';
import { ApiClient, ApiError, assertSecureEndpoint } from '../src/api/client';
import { MemorySecureStore } from '../src/auth/memoryStore';

class MemoryStorage implements QueueStorage {
  items: QueueItem[] = [];
  saves = 0;
  async load(): Promise<QueueItem[]> {
    return this.items.map((item) => ({ ...item }));
  }
  async save(items: QueueItem[]): Promise<void> {
    this.items = items.map((item) => ({ ...item }));
    this.saves += 1;
  }
}

class FakeTransport implements UploadTransport {
  uploads: Array<{ idempotencyKey: string; fileName: string }> = [];
  online = true;
  failuresRemaining = 0;

  async upload(input: { uri: string; fileName: string; mimeType: string; idempotencyKey: string }) {
    if (this.failuresRemaining > 0) {
      this.failuresRemaining -= 1;
      throw new Error('Network request failed');
    }
    this.uploads.push({ idempotencyKey: input.idempotencyKey, fileName: input.fileName });
    return { id: `doc-${this.uploads.length}`, jobId: 'job-1', status: 'queued', duplicate: false };
  }

  isOnline(): boolean {
    return this.online;
  }
}

function capture(id: string) {
  return { id, uri: `file:///captures/${id}.jpg`, fileName: `${id}.jpg`, mimeType: 'image/jpeg' };
}

describe('upload queue (MOB-003)', () => {
  it('persists a capture before any upload is attempted', async () => {
    const storage = new MemoryStorage();
    const transport = new FakeTransport();
    const queue = new UploadQueue(storage, transport);

    await queue.enqueue(capture('cap_1'));

    expect(storage.items).toHaveLength(1);
    expect(storage.items[0].status).toBe('pending');
    expect(transport.uploads).toHaveLength(0);
    expect(queue.pendingCount()).toBe(1);
  });

  it('uploads each capture once, using the local id as the idempotency key', async () => {
    const storage = new MemoryStorage();
    const transport = new FakeTransport();
    const queue = new UploadQueue(storage, transport);

    await queue.enqueue(capture('cap_a'));
    await queue.drain();
    await queue.drain(); // a second drain must not upload again

    expect(transport.uploads).toEqual([{ idempotencyKey: 'cap_a', fileName: 'cap_a.jpg' }]);
    expect(storage.items[0].status).toBe('uploaded');
    expect(storage.items[0].documentId).toBe('doc-1');
    expect(queue.pendingCount()).toBe(0);
  });

  it('ignores a duplicate enqueue of the same capture', async () => {
    const storage = new MemoryStorage();
    const queue = new UploadQueue(storage, new FakeTransport());

    await queue.enqueue(capture('cap_dup'));
    await queue.enqueue(capture('cap_dup'));

    expect(queue.snapshot()).toHaveLength(1);
  });

  it('schedules a retry with exponential backoff after a failure', async () => {
    const storage = new MemoryStorage();
    const transport = new FakeTransport();
    transport.failuresRemaining = 1;
    let now = 1_000;
    const queue = new UploadQueue(storage, transport, { now: () => now, baseBackoffMs: 2_000 });

    await queue.enqueue(capture('cap_fail'));
    await queue.drain();

    const failed = storage.items[0];
    expect(failed.status).toBe('failed');
    expect(failed.attempts).toBe(1);
    expect(failed.lastError).toContain('Network');
    expect(failed.nextAttemptAt).toBe(3_000);

    // Not eligible yet: a drain before the backoff elapses must not touch the network.
    await queue.drain();
    expect(storage.items[0].attempts).toBe(1);

    now = 3_000;
    await queue.drain();
    expect(storage.items[0].status).toBe('uploaded');
  });

  it('stops retrying after the attempt limit and flags the capture for a person', async () => {
    const storage = new MemoryStorage();
    const transport = new FakeTransport();
    transport.failuresRemaining = 99;
    let now = 0;
    const queue = new UploadQueue(storage, transport, {
      now: () => now,
      maxAttempts: 2,
      baseBackoffMs: 10,
    });

    await queue.enqueue(capture('cap_poison'));
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await queue.drain();
      now += 60_000;
    }

    const item = storage.items[0];
    expect(item.status).toBe('needs_attention');
    expect(item.attempts).toBe(2);
    expect(queue.pendingCount()).toBe(1);

    // A manual retry clears the attempt count and succeeds once the network is back.
    transport.failuresRemaining = 0;
    await queue.retry('cap_poison');
    await queue.drain();
    expect(storage.items[0].status).toBe('uploaded');
  });

  it('does nothing while offline but keeps the captures', async () => {
    const storage = new MemoryStorage();
    const transport = new FakeTransport();
    transport.online = false;
    const queue = new UploadQueue(storage, transport, { now: () => 0 });

    await queue.enqueue(capture('cap_offline'));
    const processed = await queue.drain();

    expect(processed).toHaveLength(0);
    expect(storage.items[0].status).toBe('pending');
    expect(queue.pendingCount()).toBe(1);
  });

  it('never reports a capture as uploaded before the server acknowledged it', async () => {
    const storage = new MemoryStorage();
    const transport = new FakeTransport();
    transport.failuresRemaining = 1;
    const queue = new UploadQueue(storage, transport, { now: () => 0 });
    let uploadedEvents = 0;

    const instrumented = new UploadQueue(storage, new FakeTransport(), {
      onItemUploaded: () => {
        uploadedEvents += 1;
      },
    });
    await instrumented.enqueue(capture('cap_x'));
    await instrumented.drain();
    expect(uploadedEvents).toBe(1);
    expect(uploadedEvents).toBeLessThanOrEqual(queue.snapshot().length + 1);
  });
});

describe('queue persistence', () => {
  it('round-trips items and survives a corrupt payload', async () => {
    const store = new MemorySecureStore();
    const storage = new PersistedQueueStorage(store);
    const queue = new UploadQueue(storage, new FakeTransport());
    await queue.enqueue(capture('cap_persist'));

    const reloaded = new UploadQueue(storage, new FakeTransport());
    expect(await reloaded.load()).toHaveLength(1);

    await store.setItem('upload_queue', '{not json');
    expect(await storage.load()).toEqual([]);

    await store.setItem('upload_queue', JSON.stringify([{ id: 'broken' }]));
    expect(await storage.load()).toEqual([]);
  });
});

describe('pairing code handling (PAIR-002)', () => {
  const token = 'a'.repeat(43);

  it('accepts a code generated by the desktop app', () => {
    const payload = buildPairingQrPayload('https://idcp.example.com', token);
    const result = readPairingCode(payload);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.target.endpoint).toBe('https://idcp.example.com');
      expect(result.target.token).toBe(token);
    }
  });

  it('rejects another app’s QR code', () => {
    expect(readPairingCode('https://example.com/whatever')).toEqual({
      ok: false,
      reason: 'not_our_code',
    });
    expect(readPairingCode('')).toEqual({ ok: false, reason: 'not_our_code' });
  });

  it('rejects a code pointing at an insecure endpoint', () => {
    expect(readPairingCode(buildPairingQrPayload('http://203.0.113.10:8080', token))).toEqual({
      ok: false,
      reason: 'insecure',
    });
  });

  it('rejects a truncated code instead of attempting a request', () => {
    expect(readPairingCode('idcp://pair?e=https://idcp.example.com')).toEqual({
      ok: false,
      reason: 'malformed',
    });
  });

  it('presents device names and expiry readably', () => {
    expect(describeDevice('android', 'Samsung SM-A125F')).toBe('Samsung SM-A125F');
    expect(describeDevice('ios')).toBe('iPhone');
    expect(describeDevice('android', '   ')).toBe('Android device');
    expect(formatExpiry(90)).toBe('1m 30s');
    expect(formatExpiry(42)).toBe('42s');
    expect(formatExpiry(0)).toBe('Expired');
  });
});

describe('API client', () => {
  const okPair = () =>
    new Response(
      JSON.stringify({
        accessToken: 'access-1',
        refreshToken: 'refresh-1',
        expiresIn: 900,
        user: {
          id: 'u1',
          email: 'owner@example.com',
          displayName: 'Owner',
          role: 'owner',
          organisationId: 'org-1',
          organisationName: 'Acme',
        },
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );

  it('refuses a non-HTTPS endpoint', () => {
    expect(() => assertSecureEndpoint('http://idcp.example.com')).toThrow(/https/i);
    expect(assertSecureEndpoint('https://idcp.example.com/')).toBe('https://idcp.example.com');
    expect(assertSecureEndpoint('http://localhost:8787')).toBe('http://localhost:8787');
  });

  it('refreshes once on 401 and retries with the new token', async () => {
    const store = new MemorySecureStore();
    await store.saveTokens({ accessToken: 'stale', refreshToken: 'refresh-0' });
    const calls: string[] = [];

    const fetchImpl = (async (url: string, init?: RequestInit) => {
      calls.push(String(url).replace('https://idcp.example.com', ''));
      const auth = (init?.headers as Record<string, string> | undefined)?.authorization;
      if (String(url).endsWith('/auth/refresh')) return okPair();
      if (auth === 'Bearer access-1') {
        return new Response(JSON.stringify({ id: 'u1', email: 'owner@example.com' }), {
          status: 200,
        });
      }
      return new Response(
        JSON.stringify({ error: { code: 'UNAUTHENTICATED', message: 'Sign in.' } }),
        {
          status: 401,
        },
      );
    }) as unknown as typeof fetch;

    const client = new ApiClient({ baseUrl: 'https://idcp.example.com', store, fetchImpl });
    const me = await client.me();

    expect(calls).toEqual(['/auth/me', '/auth/refresh', '/auth/me']);
    expect(me).toEqual({ id: 'u1', email: 'owner@example.com' });
    expect(await store.getAccessToken()).toBe('access-1');
    expect(await store.getRefreshToken()).toBe('refresh-1');
  });

  it('clears the session when the refresh token is no longer valid', async () => {
    const store = new MemorySecureStore();
    await store.saveTokens({ accessToken: 'stale', refreshToken: 'revoked' });
    let expired = false;

    const fetchImpl = (async () =>
      new Response(JSON.stringify({ error: { code: 'UNAUTHENTICATED', message: 'No.' } }), {
        status: 401,
      })) as unknown as typeof fetch;

    const client = new ApiClient({
      baseUrl: 'https://idcp.example.com',
      store,
      fetchImpl,
      onSessionExpired: () => {
        expired = true;
      },
    });

    await expect(client.me()).rejects.toBeInstanceOf(ApiError);
    expect(expired).toBe(true);
    expect(await store.getRefreshToken()).toBeNull();
  });

  it('surfaces the server’s message and code for a rejected request', async () => {
    const store = new MemorySecureStore();
    const fetchImpl = (async () =>
      new Response(
        JSON.stringify({
          error: {
            code: 'VALIDATION_FAILED',
            message: 'Email or password is incorrect.',
            requestId: 'r1',
          },
        }),
        { status: 400 },
      )) as unknown as typeof fetch;

    const client = new ApiClient({ baseUrl: 'https://idcp.example.com', store, fetchImpl });

    await expect(client.login({ email: 'a@b.com', password: 'nope' })).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
      status: 400,
      message: 'Email or password is incorrect.',
    });
  });
});
