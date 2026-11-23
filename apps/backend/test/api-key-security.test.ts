import {
  acceptInvite,
  createHarness,
  registerAccount,
  type Harness,
  type TestAccount,
} from './helpers';

describe('API key issuance and expiry safety', () => {
  let harness: Harness;
  let owner: TestAccount;
  beforeEach(async () => {
    harness = await createHarness();
    owner = await registerAccount(harness);
  });
  afterEach(async () => {
    await harness.close();
  });
  const issue = async (scopes: string[], expiresInDays?: number) => {
    const response = await harness.api.json('POST', '/api/v1/api-keys', {
      token: owner.accessToken,
      body: { name: 'Test key', scopes, ...(expiresInDays === undefined ? {} : { expiresInDays }) },
    });
    expect(response.statusCode).toBe(201);
    return response.json<{ id: string; key: string; expiresAt: string | null }>();
  };

  it.each(['connectors:write', 'admin'])(
    'does not allow %s keys to create, list or revoke keys',
    async (scope) => {
      const key = await issue([scope]);
      const before = await harness.db.query('SELECT id FROM api_keys WHERE organisation_id = ?', [
        owner.organisationId,
      ]);
      const headers = { 'x-api-key': key.key };
      const create = await harness.api.json('POST', '/api/v1/api-keys', {
        headers,
        body: { name: 'delegated', scopes: ['documents:write'] },
      });
      expect(create.statusCode).toBe(403);
      expect((await harness.api.json('GET', '/api/v1/api-keys', { headers })).statusCode).toBe(403);
      expect(
        (await harness.api.json('DELETE', `/api/v1/api-keys/${key.id}`, { headers })).statusCode,
      ).toBe(403);
      expect(
        await harness.db.query('SELECT id FROM api_keys WHERE organisation_id = ?', [
          owner.organisationId,
        ]),
      ).toEqual(before);
      expect(
        await harness.db.one('SELECT revoked_at FROM api_keys WHERE id = ?', [key.id]),
      ).toEqual({
        revoked_at: null,
      });
      expect(
        await harness.db.query('SELECT id FROM audit_logs WHERE action = ? AND target_id = ?', [
          'api_key.revoked',
          key.id,
        ]),
      ).toHaveLength(0);
    },
  );

  it('does not expose key metadata to a viewer, but lets an owner manage keys', async () => {
    expect(
      (
        await harness.api.json('POST', '/api/v1/users/invite', {
          token: owner.accessToken,
          body: { email: 'viewer-key@example.com', role: 'viewer' },
        })
      ).statusCode,
    ).toBe(202);
    const viewer = await acceptInvite(harness, 'viewer-key@example.com');
    const key = await issue(['documents:read']);
    expect((await harness.api.get('/api/v1/api-keys', viewer.accessToken)).statusCode).toBe(403);
    expect((await harness.api.get('/api/v1/api-keys', owner.accessToken)).statusCode).toBe(200);
    expect(
      (await harness.api.json('DELETE', `/api/v1/api-keys/${key.id}`, { token: owner.accessToken }))
        .statusCode,
    ).toBe(200);
  });

  it('enforces the requested expiry and exposes the stored expiry', async () => {
    const start = Date.now();
    const key = await issue(['documents:read'], 1);
    const expiry = Date.parse(key.expiresAt!);
    expect(expiry).toBeGreaterThanOrEqual(start + 24 * 60 * 60 * 1000);
    expect(expiry).toBeLessThanOrEqual(Date.now() + 24 * 60 * 60 * 1000);
    const list = await harness.api.get('/api/v1/api-keys', owner.accessToken);
    expect(
      list
        .json<{ items: Array<{ id: string; expiresAt: string | null }> }>()
        .items.find((row) => row.id === key.id)?.expiresAt,
    ).toBe(key.expiresAt);
    expect(
      (await harness.api.json('GET', '/api/v1/documents', { headers: { 'x-api-key': key.key } }))
        .statusCode,
    ).toBe(200);
    await harness.db.execute('UPDATE api_keys SET expires_at = ? WHERE id = ?', [
      '2000-01-01T00:00:00.000Z',
      key.id,
    ]);
    expect(
      (await harness.api.json('GET', '/api/v1/documents', { headers: { 'x-api-key': key.key } }))
        .statusCode,
    ).toBe(401);
  });

  it('allows a signed-in admin to manage keys but not issue the admin scope', async () => {
    expect(
      (
        await harness.api.json('POST', '/api/v1/users/invite', {
          token: owner.accessToken,
          body: { email: 'admin-key@example.com', role: 'admin' },
        })
      ).statusCode,
    ).toBe(202);
    const admin = await acceptInvite(harness, 'admin-key@example.com');
    const create = (scopes: string[]) =>
      harness.api.json('POST', '/api/v1/api-keys', {
        token: admin.accessToken,
        body: { name: 'admin-managed', scopes },
      });
    expect((await create(['admin'])).statusCode).toBe(403);
    const result = await create(['documents:read']);
    expect(result.statusCode).toBe(201);
    expect((await harness.api.get('/api/v1/api-keys', admin.accessToken)).statusCode).toBe(200);
    expect(
      (
        await harness.api.json('DELETE', `/api/v1/api-keys/${result.json<{ id: string }>().id}`, {
          token: admin.accessToken,
        })
      ).statusCode,
    ).toBe(200);
  });

  it('denies API key and device actors at the service boundary', async () => {
    for (const actorType of ['api_key', 'device'] as const) {
      const actor = {
        userId: owner.userId,
        organisationId: owner.organisationId,
        role: 'owner' as const,
        actorType,
      };
      await expect(
        harness.services.apiKeys.create(actor, { name: 'no', scopes: ['admin'] }),
      ).rejects.toMatchObject({ code: 'ROLE_REQUIRED' });
      await expect(harness.services.apiKeys.list(actor)).rejects.toMatchObject({
        code: 'ROLE_REQUIRED',
      });
      await expect(harness.services.apiKeys.revoke(actor, 'irrelevant')).rejects.toMatchObject({
        code: 'ROLE_REQUIRED',
      });
    }
    expect(
      await harness.db.query('SELECT id FROM api_keys WHERE organisation_id = ?', [
        owner.organisationId,
      ]),
    ).toHaveLength(0);
  });

  it('requires expiry to be an integer in the supported range in direct service calls', async () => {
    const actor = {
      userId: owner.userId,
      organisationId: owner.organisationId,
      role: 'owner' as const,
      actorType: 'user' as const,
    };
    for (const expiresInDays of [0, -1, 1.5, 731, Infinity, NaN]) {
      await expect(
        harness.services.apiKeys.create(actor, {
          name: 'no',
          scopes: ['documents:read'],
          expiresInDays,
        }),
      ).rejects.toMatchObject({ code: 'FIELD_VALIDATION_FAILED' });
    }
    expect(
      await harness.db.query('SELECT id FROM api_keys WHERE organisation_id = ?', [
        owner.organisationId,
      ]),
    ).toHaveLength(0);
  });

  it('denies an expiry exactly at the current time without updating last use', async () => {
    const key = await issue(['documents:read'], 1);
    const now = Date.now();
    await harness.db.execute('UPDATE api_keys SET expires_at = ? WHERE id = ?', [
      new Date(now).toISOString(),
      key.id,
    ]);
    const clock = jest.spyOn(Date, 'now').mockReturnValue(now);
    try {
      expect(await harness.services.apiKeys.authenticate(key.key)).toBeNull();
      expect(
        await harness.db.one('SELECT last_used_at FROM api_keys WHERE id = ?', [key.id]),
      ).toEqual({ last_used_at: null });
    } finally {
      clock.mockRestore();
    }
  });

  it('fails closed for malformed stored expiries, and allows explicitly non-expiring keys', async () => {
    const key = await issue(['documents:read']);
    expect(key.expiresAt).toBeNull();
    expect(
      (await harness.api.json('GET', '/api/v1/documents', { headers: { 'x-api-key': key.key } }))
        .statusCode,
    ).toBe(200);
    for (const expiry of ['', 'not-a-date', '9999-99-99T00:00:00.000Z', '2999-01-01']) {
      await harness.db.execute('UPDATE api_keys SET expires_at = ? WHERE id = ?', [expiry, key.id]);
      expect(
        (await harness.api.json('GET', '/api/v1/documents', { headers: { 'x-api-key': key.key } }))
          .statusCode,
      ).toBe(401);
    }
  });
});
