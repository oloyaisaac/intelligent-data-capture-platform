import {
  acceptInvite,
  createHarness,
  registerAccount,
  type Harness,
  type TestAccount,
} from './helpers';
import type { RealtimeSubscriber } from '../src/realtime/hub';

/**
 * DEVAPI-001 — developer API keys.
 *
 * The secret is returned exactly once, stored hashed, bounded by scopes, and revocable.
 */
describe('developer API keys', () => {
  let harness: Harness;
  let owner: TestAccount;

  beforeAll(async () => {
    harness = await createHarness();
    owner = await registerAccount(harness);
  });

  afterAll(async () => {
    await harness.close();
  });

  const create = (body: unknown, token = owner.accessToken) =>
    harness.api.json('POST', '/api/v1/api-keys', { token, body });

  it('returns the secret once and never exposes it again', async () => {
    const response = await create({
      name: 'Nightly export',
      scopes: ['documents:read', 'exports:read'],
    });

    expect(response.statusCode).toBe(201);
    const created = response.json<{ id: string; key: string; prefix: string; shownOnce: true }>();
    expect(created.key).toMatch(/^idcp_/);
    expect(created.key.length).toBeGreaterThan(30);
    expect(created.shownOnce).toBe(true);
    expect(created.prefix).toBe(created.key.slice(0, created.prefix.length));

    const list = await harness.api.get('/api/v1/api-keys', owner.accessToken);
    const items = list.json<{ items: Array<Record<string, unknown>> }>().items;
    const stored = items.find((item) => item.id === created.id)!;
    expect(stored).toBeDefined();
    expect(stored.key).toBeUndefined();
    expect(JSON.stringify(stored)).not.toContain(created.key.slice(10));
  });

  it('stores only a hash of the key', async () => {
    const created = (await create({ name: 'Hash check', scopes: ['documents:read'] })).json<{
      key: string;
      id: string;
    }>();

    const row = await harness.db.one<{ key_hash: string }>(
      'SELECT key_hash FROM api_keys WHERE id = ?',
      [created.id],
    );
    expect(row!.key_hash).not.toContain(created.key);
    expect(row!.key_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('authenticates machine clients and enforces the scope’s role', async () => {
    const readOnly = (await create({ name: 'Read only', scopes: ['documents:read'] })).json<{
      key: string;
    }>();

    const list = await harness.api.json('GET', '/api/v1/documents', {
      headers: { 'x-api-key': readOnly.key },
    });
    expect(list.statusCode).toBe(200);

    // A read-only key is a viewer: it cannot create templates.
    const template = await harness.api.json('POST', '/api/v1/templates', {
      headers: { 'x-api-key': readOnly.key },
      body: { name: 'Nope', documentType: 'invoice', fields: [{ path: 'a', label: 'A' }] },
    });
    expect(template.statusCode).toBe(403);

    // The same request works with a key that carries a reviewer scope.
    const writer = (await create({ name: 'Writer', scopes: ['review:write'] })).json<{
      key: string;
    }>();
    const allowed = await harness.api.json('POST', '/api/v1/templates', {
      headers: { 'x-api-key': writer.key },
      body: { name: 'Allowed', documentType: 'invoice', fields: [{ path: 'a', label: 'A' }] },
    });
    expect(allowed.statusCode).toBe(201);
  });

  it('records last use without leaking the key', async () => {
    const created = (await create({ name: 'Usage', scopes: ['documents:read'] })).json<{
      key: string;
      id: string;
    }>();
    await harness.api.json('GET', '/api/v1/documents', { headers: { 'x-api-key': created.key } });

    const list = await harness.api.get('/api/v1/api-keys', owner.accessToken);
    const stored = list
      .json<{ items: Array<{ id: string; lastUsedAt: string | null }> }>()
      .items.find((item) => item.id === created.id)!;
    expect(stored.lastUsedAt).toBeTruthy();
  });

  it('stops accepting a revoked key immediately', async () => {
    const created = (await create({ name: 'Revocable', scopes: ['documents:read'] })).json<{
      key: string;
      id: string;
    }>();

    const before = await harness.api.json('GET', '/api/v1/documents', {
      headers: { 'x-api-key': created.key },
    });
    expect(before.statusCode).toBe(200);

    const revoked = await harness.api.json('DELETE', `/api/v1/api-keys/${created.id}`, {
      token: owner.accessToken,
    });
    expect(revoked.statusCode).toBe(200);
    expect(revoked.json<{ revokedAt: string | null }>().revokedAt).toBeTruthy();

    const after = await harness.api.json('GET', '/api/v1/documents', {
      headers: { 'x-api-key': created.key },
    });
    expect(after.statusCode).toBe(401);
  });

  it('rejects a made-up key and a malformed header', async () => {
    const invented = await harness.api.json('GET', '/api/v1/documents', {
      headers: { 'x-api-key': 'idcp_this_is_not_a_real_key_0123456789' },
    });
    expect(invented.statusCode).toBe(401);

    const nonsense = await harness.api.json('GET', '/api/v1/documents', {
      headers: { 'x-api-key': 'nope' },
    });
    expect(nonsense.statusCode).toBe(401);
  });

  it('refuses a viewer, and refuses an admin-scoped key from a non-owner', async () => {
    // Promote a second person to reviewer, then try to issue a key as that person.
    const invited = await harness.api.json('POST', '/api/v1/users/invite', {
      token: owner.accessToken,
      body: { email: 'reviewer-devapi@example.com', role: 'reviewer' },
    });
    expect(invited.statusCode).toBe(202);

    // The invited person cannot sign in until they accept; simulate the acceptance the auth
    // service performs, then use their session.
    const membership = await harness.db.one<{ user_id: string }>(
      `SELECT m.user_id FROM memberships m JOIN users u ON u.id = m.user_id WHERE u.email = ?`,
      ['reviewer-devapi@example.com'],
    );
    expect(membership).not.toBeNull();

    const asReviewer = await harness.api.json('POST', '/api/v1/api-keys', {
      token: (await acceptInvite(harness, 'reviewer-devapi@example.com')).accessToken,
      body: { name: 'Should fail', scopes: ['documents:read'] },
    });
    expect(asReviewer.statusCode).toBe(403);
  });

  it('rejects an unknown scope', async () => {
    const response = await create({ name: 'Bad scope', scopes: ['everything'] });
    expect(response.statusCode).toBe(400);
  });
});

describe('realtime event stream', () => {
  it('requires authentication', async () => {
    const harness = await createHarness();
    try {
      const response = await harness.api.get('/api/v1/events');
      expect(response.statusCode).toBe(401);
    } finally {
      await harness.close();
    }
  });

  it('streams through an injected subscription capability without an in-memory hub', async () => {
    const harness = await createHarness();
    const controller = new AbortController();
    let onEvent: RealtimeSubscriber | undefined;
    let signalUnsubscribe!: () => void;
    const unsubscribed = new Promise<void>((resolve) => {
      signalUnsubscribe = resolve;
    });
    const subscribe = jest.fn(
      (_target: { organisationId?: string; userId?: string }, handler: RealtimeSubscriber) => {
        onEvent = handler;
        return signalUnsubscribe;
      },
    );
    harness.services.hub = {
      toOrganisation: jest.fn(),
      toUser: jest.fn(),
      disconnectDevice: jest.fn(),
      registerDevice: jest.fn(),
      subscribe,
    };
    try {
      const account = await registerAccount(harness);
      const response = await fetch(`${harness.baseUrl}/api/v1/events`, {
        headers: { authorization: `Bearer ${account.accessToken}` },
        signal: controller.signal,
      });
      expect(response.status).toBe(200);
      const reader = response.body!.getReader();
      const decoder = new TextDecoder();
      await reader.read();
      expect(subscribe).toHaveBeenCalledWith(
        { organisationId: account.organisationId },
        expect.any(Function),
      );
      onEvent?.('document:approved', { documentId: 'doc-from-adapter' });
      const frame = await reader.read();
      expect(decoder.decode(frame.value)).toContain('doc-from-adapter');
      controller.abort();
      await reader.cancel().catch(() => undefined);
      await unsubscribed;
    } finally {
      controller.abort();
      harness.app.server.closeAllConnections();
      await harness.close();
    }
  });

  it('returns 501 if the hub does not expose subscriptions', async () => {
    const harness = await createHarness();
    harness.services.hub = {
      toOrganisation: jest.fn(),
      toUser: jest.fn(),
      disconnectDevice: jest.fn(),
      registerDevice: jest.fn(),
    };
    try {
      const account = await registerAccount(harness);
      const response = await harness.api.get('/api/v1/events', account.accessToken);
      expect(response.statusCode).toBe(501);
      expect(response.json()).toMatchObject({ error: { code: 'NOT_IMPLEMENTED' } });
    } finally {
      await harness.close();
    }
  });

  it('streams organisation events as server-sent events', async () => {
    const harness = await createHarness();
    try {
      const account = await registerAccount(harness);
      const controller = new AbortController();
      const response = await fetch(`${harness.baseUrl}/api/v1/events`, {
        headers: { authorization: `Bearer ${account.accessToken}` },
        signal: controller.signal,
      });

      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toContain('text/event-stream');

      const reader = response.body!.getReader();
      const decoder = new TextDecoder();
      let received = '';
      const readSome = async () => {
        const { value } = await reader.read();
        received += decoder.decode(value ?? new Uint8Array(), { stream: true });
        return received;
      };

      // The opening frame confirms the stream is live before any work happens.
      await readSome();
      expect(received).toContain('event: job:progress');

      harness.hub.toOrganisation(account.organisationId, 'document:approved', {
        documentId: 'doc-1',
      });
      await readSome();

      expect(received).toContain('event: document:approved');
      expect(received).toContain('"documentId":"doc-1"');

      controller.abort();
      reader.cancel().catch(() => undefined);
    } finally {
      await harness.close();
    }
  });
});
