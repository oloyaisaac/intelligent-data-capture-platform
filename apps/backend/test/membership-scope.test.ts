import { createHarness, registerAccount, type Harness } from './helpers';

describe('credential membership organisation boundaries', () => {
  let harness: Harness;
  beforeEach(async () => {
    harness = await createHarness();
  });
  afterEach(async () => {
    await harness.close();
  });

  async function secondOrganisation(role: 'reviewer' | 'admin' = 'reviewer') {
    const person = await registerAccount(harness);
    const owner = await registerAccount(harness);
    const invited = await harness.api.json('POST', '/api/v1/users/invite', {
      token: owner.accessToken,
      body: { email: person.email, role },
    });
    expect(invited.statusCode).toBe(202);
    const token = invited.json<{ invitation: { token: string } }>().invitation.token;
    const accepted = await harness.api.json('POST', `/api/v1/invitations/${token}/accept`, {
      body: { password: 'correct horse battery staple' },
    });
    expect(accepted.statusCode).toBe(200);
    const session = accepted.json<{ accessToken: string; refreshToken: string }>();
    return { person, owner, session };
  }

  it('uses the token organisation and live role rather than the first membership', async () => {
    const { person, owner, session } = await secondOrganisation();
    const me = await harness.api.get('/api/v1/auth/me', session.accessToken);
    expect(me.statusCode).toBe(200);
    expect(me.json()).toMatchObject({ organisationId: owner.organisationId, role: 'reviewer' });
    const denied = await harness.api.json('PATCH', '/api/v1/organisation', {
      token: session.accessToken,
      body: { name: 'Not permitted' },
    });
    expect(denied.statusCode).toBe(403);
    const refreshed = await harness.api.json('POST', '/api/v1/auth/refresh', {
      body: { refreshToken: session.refreshToken },
    });
    expect(refreshed.statusCode).toBe(200);
    expect(refreshed.json()).toMatchObject({
      user: { organisationId: owner.organisationId, role: 'reviewer' },
    });
    const next = refreshed.json<{ accessToken: string; refreshToken: string }>();
    await harness.db.execute('DELETE FROM memberships WHERE organisation_id = ? AND user_id = ?', [
      owner.organisationId,
      person.userId,
    ]);
    expect((await harness.api.get('/api/v1/auth/me', next.accessToken)).statusCode).toBe(401);
    expect(
      (
        await harness.api.json('POST', '/api/v1/auth/refresh', {
          body: { refreshToken: next.refreshToken },
        })
      ).statusCode,
    ).toBe(401);
    expect((await harness.api.get('/api/v1/auth/me', person.accessToken)).statusCode).toBe(200);
  });

  it('rejects unaccepted memberships even with a signed token', async () => {
    const person = await registerAccount(harness);
    const owner = await registerAccount(harness);
    const invited = await harness.api.json('POST', '/api/v1/users/invite', {
      token: owner.accessToken,
      body: { email: person.email, role: 'reviewer' },
    });
    expect(invited.statusCode).toBe(202);
    const token = harness.services.tokens.signAccessToken({
      sub: person.userId,
      org: owner.organisationId,
      role: 'reviewer',
    });
    expect((await harness.api.get('/api/v1/auth/me', token)).statusCode).toBe(401);
    expect(
      (await harness.api.get(`/api/v1/events?access_token=${encodeURIComponent(token)}`))
        .statusCode,
    ).toBe(401);
  });

  it('routes query-token event streams only to the token organisation', async () => {
    const { person, owner, session } = await secondOrganisation();
    const controller = new AbortController();
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    try {
      const response = await fetch(
        `${harness.baseUrl}/api/v1/events?access_token=${encodeURIComponent(session.accessToken)}`,
        { signal: controller.signal },
      );
      expect(response.status).toBe(200);
      reader = response.body!.getReader();
      await reader.read();
      harness.hub.toOrganisation(person.organisationId, 'document:approved', {
        documentId: 'wrong-org',
      });
      harness.hub.toOrganisation(owner.organisationId, 'document:approved', {
        documentId: 'correct-org',
      });
      const event = new TextDecoder().decode((await reader.read()).value);
      expect(event).toContain('correct-org');
      expect(event).not.toContain('wrong-org');
    } finally {
      controller.abort();
      await reader?.cancel().catch(() => undefined);
    }
  });

  it('rechecks the device owner role within the device organisation', async () => {
    const { person, owner, session } = await secondOrganisation();
    const start = await harness.api.json('POST', '/api/v1/pairing/sessions', {
      token: session.accessToken,
    });
    expect(start.statusCode).toBe(201);
    const pairingToken = start.json<{ token: string }>().token;
    const paired = await harness.api.json('POST', '/api/v1/pairing/complete', {
      body: {
        token: pairingToken,
        device: { name: 'Test phone', platform: 'android', appVersion: '0.1.0' },
      },
    });
    expect(paired.statusCode).toBe(201);
    const credential = paired.json<{ deviceCredential: string }>().deviceCredential;
    const denied = await harness.api.json('PATCH', '/api/v1/organisation', {
      headers: { 'x-device-credential': credential },
      body: { name: 'Not permitted' },
    });
    expect(denied.statusCode).toBe(403);
    await harness.db.execute('DELETE FROM memberships WHERE organisation_id = ? AND user_id = ?', [
      owner.organisationId,
      person.userId,
    ]);
    const removed = await harness.api.json('GET', '/api/v1/devices', {
      headers: { 'x-device-credential': credential },
    });
    expect(removed.statusCode).toBe(401);
  });

  it('keeps an API key in its own organisation and caps it by the live role', async () => {
    const { person, owner, session } = await secondOrganisation('admin');
    const created = await harness.api.json('POST', '/api/v1/api-keys', {
      token: session.accessToken,
      body: { name: 'Scoped key', scopes: ['review:write'] },
    });
    expect(created.statusCode).toBe(201);
    const key = created.json<{ key: string }>().key;
    expect(await harness.services.apiKeys.authenticate(key)).toMatchObject({
      organisationId: owner.organisationId,
      role: 'reviewer',
    });
    await harness.db.execute(
      'UPDATE memberships SET role = ? WHERE organisation_id = ? AND user_id = ?',
      ['viewer', owner.organisationId, person.userId],
    );
    expect(await harness.services.apiKeys.authenticate(key)).toMatchObject({
      organisationId: owner.organisationId,
      role: 'viewer',
    });
    await harness.db.execute('DELETE FROM memberships WHERE organisation_id = ? AND user_id = ?', [
      owner.organisationId,
      person.userId,
    ]);
    expect(await harness.services.apiKeys.authenticate(key)).toBeNull();
  });
});
