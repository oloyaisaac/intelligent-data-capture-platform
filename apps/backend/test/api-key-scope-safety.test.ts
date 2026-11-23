import {
  acceptInvite,
  createHarness,
  registerAccount,
  type Harness,
  type TestAccount,
} from './helpers';
import { API_KEY_ROUTES, apiKeyRoleForRoute } from '../src/http/api-key-policy';
import { API_KEY_SCOPES } from '@idcp/shared';
import type { HTTPMethods } from 'fastify';
import { roleForScopes, type ApiKeyPrincipal } from '../src/services/api-key-service';

describe('API key scope isolation at the HTTP boundary', () => {
  let harness: Harness;
  let owner: TestAccount;
  beforeAll(async () => {
    harness = await createHarness();
    owner = await registerAccount(harness);
  });
  afterAll(async () => {
    await harness.close();
  });

  const key = async (scopes: string[]) => {
    const result = await harness.api.json('POST', '/api/v1/api-keys', {
      token: owner.accessToken,
      body: { name: scopes.join(','), scopes },
    });
    expect(result.statusCode).toBe(201);
    return result.json<{ key: string }>().key;
  };

  it('maps only real route templates and denies every unrelated single scope', () => {
    for (const [entry, required] of Object.entries(API_KEY_ROUTES)) {
      const [method, url] = entry.split(' ') as [HTTPMethods, string];
      expect(harness.app.hasRoute({ method, url })).toBe(true);
      for (const scope of API_KEY_SCOPES) {
        const principal: ApiKeyPrincipal = {
          organisationId: 'org',
          userId: 'user',
          keyId: 'key',
          role: 'admin',
          scopes: [scope],
        };
        const actual = apiKeyRoleForRoute(principal, method, url);
        if (scope === required || scope === 'admin') expect(actual).not.toBeNull();
        else expect(actual).toBeNull();
      }
    }
  });

  it('does not allow a review key to delete a document', async () => {
    const review = await key(['review:write']);
    const upload = await harness.api.upload(owner.accessToken);
    const id = upload.json<{ id: string }>().id;
    expect(
      (
        await harness.api.json('DELETE', `/api/v1/documents/${id}`, {
          headers: { 'x-api-key': review },
        })
      ).statusCode,
    ).toBe(403);
    expect(await harness.db.one('SELECT deleted_at FROM documents WHERE id = ?', [id])).toEqual({
      deleted_at: null,
    });
  });

  it('allows the explicit scope union without allowing unrelated operations', async () => {
    const combined = await key(['documents:read', 'review:write']);
    const headers = { 'x-api-key': combined };
    expect(
      (await harness.api.json('GET', '/api/v1/documents?limit=1', { headers })).statusCode,
    ).toBe(200);
    expect((await harness.api.json('HEAD', '/api/v1/documents', { headers })).statusCode).toBe(200);
    expect((await harness.api.json('GET', '/api/v1/review/queue', { headers })).statusCode).toBe(
      200,
    );
    expect((await harness.api.json('GET', '/api/v1/exports', { headers })).statusCode).toBe(403);
    expect(
      (
        await harness.api.json('POST', '/api/v1/workflows/evaluate', {
          headers,
          body: { trigger: 'document.approved' },
        })
      ).statusCode,
    ).toBe(403);
    expect((await harness.api.json('GET', '/api/v1/auth/me', { headers })).statusCode).toBe(403);
  });

  it('rejects unlisted routes and methods for admin keys even if a route has no auth guard', async () => {
    const admin = await key(['admin']);
    expect((await harness.api.get('/api/v1/legal')).statusCode).toBe(200);
    expect(
      (await harness.api.json('GET', '/api/v1/legal', { headers: { 'x-api-key': admin } }))
        .statusCode,
    ).toBe(403);
    expect(
      (await harness.api.json('GET', '/api/v1/templates', { headers: { 'x-api-key': admin } }))
        .statusCode,
    ).toBe(403);
    expect(
      (await harness.api.json('GET', '/api/v1/workflows', { headers: { 'x-api-key': admin } }))
        .statusCode,
    ).toBe(200);
    const malformed = await fetch(`${harness.baseUrl}/api/v1/templates`, {
      method: 'POST',
      headers: { 'x-api-key': admin, 'content-type': 'application/json' },
      body: '{',
    });
    expect(malformed.status).toBe(403);
    expect(
      (
        await harness.api.json('GET', '/api/v1/documents', {
          headers: { 'x-api-key': admin, authorization: `Bearer ${owner.accessToken}` },
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (
        await harness.api.json('GET', '/api/v1/templates', {
          headers: { 'x-api-key': admin, authorization: `Bearer ${owner.accessToken}` },
        })
      ).statusCode,
    ).toBe(403);
  });

  it('still applies the creator membership cap and tenant isolation', async () => {
    const invite = await harness.api.json('POST', '/api/v1/users/invite', {
      token: owner.accessToken,
      body: { email: 'scope-admin@example.com', role: 'admin' },
    });
    expect(invite.statusCode).toBe(202);
    const admin = await acceptInvite(harness, 'scope-admin@example.com');
    const issued = await harness.api.json('POST', '/api/v1/api-keys', {
      token: admin.accessToken,
      body: { name: 'membership cap', scopes: ['documents:read', 'connectors:write'] },
    });
    expect(issued.statusCode).toBe(201);
    const headers = { 'x-api-key': issued.json<{ key: string }>().key };
    const readOnlyIssued = await harness.api.json('POST', '/api/v1/api-keys', {
      token: admin.accessToken,
      body: { name: 'read only', scopes: ['documents:read'] },
    });
    expect(readOnlyIssued.statusCode).toBe(201);
    const readOnly = readOnlyIssued.json<{ key: string }>().key;
    expect(
      (await harness.api.json('POST', '/api/v1/connectors', { headers, body: {} })).statusCode,
    ).toBe(400);
    await harness.db.execute(
      'UPDATE memberships SET role = ? WHERE organisation_id = ? AND user_id = ?',
      ['operator', owner.organisationId, admin.userId],
    );
    expect(await harness.services.apiKeys.authenticate(readOnly)).toMatchObject({ role: 'viewer' });
    expect(await harness.services.apiKeys.authenticate(headers['x-api-key'])).toMatchObject({
      role: 'operator',
    });
    await harness.db.execute(
      'UPDATE memberships SET role = ? WHERE organisation_id = ? AND user_id = ?',
      ['viewer', owner.organisationId, admin.userId],
    );
    expect(
      (await harness.api.json('POST', '/api/v1/connectors', { headers, body: {} })).statusCode,
    ).toBe(403);
    const other = await registerAccount(harness);
    const upload = await harness.api.upload(other.accessToken);
    const id = upload.json<{ id: string }>().id;
    expect((await harness.api.json('GET', `/api/v1/documents/${id}`, { headers })).statusCode).toBe(
      404,
    );
    await harness.db.execute('DELETE FROM memberships WHERE organisation_id = ? AND user_id = ?', [
      owner.organisationId,
      admin.userId,
    ]);
    expect((await harness.api.json('GET', '/api/v1/documents', { headers })).statusCode).toBe(401);
  });

  it('does not allow a connector-only key to read exports or manage templates', async () => {
    const connector = await key(['connectors:write']);
    expect(
      (await harness.api.json('GET', '/api/v1/exports', { headers: { 'x-api-key': connector } }))
        .statusCode,
    ).toBe(403);
    expect(
      (
        await harness.api.json('POST', '/api/v1/templates', {
          headers: { 'x-api-key': connector },
          body: {
            name: 'cross-scope',
            documentType: 'invoice',
            fields: [{ path: 'a', label: 'A' }],
          },
        })
      ).statusCode,
    ).toBe(403);
  });
});

it('uses only the matched scope role and caps it at live membership', () => {
  const principal: ApiKeyPrincipal = {
    organisationId: 'org',
    userId: 'user',
    keyId: 'key',
    role: 'admin',
    scopes: ['documents:read', 'connectors:write'],
  };
  expect(apiKeyRoleForRoute(principal, 'GET', '/api/v1/documents')).toBe('viewer');
  expect(apiKeyRoleForRoute(principal, 'HEAD', '/api/v1/documents')).toBe('viewer');
  expect(apiKeyRoleForRoute(principal, 'POST', '/api/v1/connectors')).toBe('admin');
  expect(apiKeyRoleForRoute({ ...principal, role: 'reviewer' }, 'POST', '/api/v1/connectors')).toBe(
    'reviewer',
  );
  expect(apiKeyRoleForRoute(principal, 'POST', '/api/v1/documents')).toBeNull();
  expect(apiKeyRoleForRoute(principal, 'GET', '/api/v1/documents/anything')).toBeNull();
  expect(apiKeyRoleForRoute(principal, 'GET', undefined)).toBeNull();
  expect(roleForScopes(['__proto__', 'constructor', 'toString'])).toBeNull();
});
