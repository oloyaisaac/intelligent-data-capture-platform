import { createHarness, registerAccount, type Harness } from './helpers';

/**
 * Password recovery and session control (DEC-030).
 *
 * The properties that matter: a reset request never reveals whether an address exists, the token is
 * single-use, using it kills every session, and a password change keeps only the caller's own.
 */
describe('password recovery and sessions', () => {
  let harness: Harness;

  beforeEach(async () => {
    harness = await createHarness();
  });

  afterEach(async () => {
    await harness.close();
  });

  interface Call<T> {
    status: number;
    body: T;
  }

  async function call<T>(
    method: 'GET' | 'POST' | 'DELETE',
    path: string,
    options: { token?: string; body?: unknown } = {},
  ): Promise<Call<T>> {
    const response = await harness.api.json(method, path, options);
    return { status: response.statusCode, body: response.json<T>() };
  }

  interface ForgotResponse {
    accepted: true;
    resetUrl?: string;
  }

  async function forgot(email: string): Promise<Call<ForgotResponse>> {
    return call<ForgotResponse>('POST', '/api/v1/auth/password/forgot', { body: { email } });
  }

  function tokenFrom(resetUrl: string): string {
    return new URL(resetUrl.replace('/#/', '/')).searchParams.get('token') ?? '';
  }

  it('always answers the same way, whether or not the address exists', async () => {
    const account = await registerAccount(harness);
    const known = await forgot(account.email);
    const unknown = await forgot('nobody-here@example.com');

    expect(known.status).toBe(202);
    expect(unknown.status).toBe(202);
    expect(unknown.body.accepted).toBe(true);
    // The dev-only link is the only difference, and it exists only for a real account.
    expect(known.body.resetUrl).toContain('token=');
    expect(unknown.body.resetUrl).toBeUndefined();
  });

  it('resets the password once, then rejects the same token', async () => {
    const account = await registerAccount(harness);
    const resetUrl = (await forgot(account.email)).body.resetUrl!;
    const token = tokenFrom(resetUrl);
    expect(token.length).toBeGreaterThan(20);

    const first = await call('POST', '/api/v1/auth/password/reset', {
      body: { token, password: 'a brand new passphrase' },
    });
    expect(first.status).toBe(204);

    const second = await call('POST', '/api/v1/auth/password/reset', {
      body: { token, password: 'another brand new phrase' },
    });
    expect(second.status).toBe(401);

    const oldLogin = await call('POST', '/api/v1/auth/login', {
      body: { email: account.email, password: 'correct horse battery staple' },
    });
    expect(oldLogin.status).toBe(401);

    const newLogin = await call('POST', '/api/v1/auth/login', {
      body: { email: account.email, password: 'a brand new passphrase' },
    });
    expect(newLogin.status).toBe(200);
  });

  it('revokes every session when a reset succeeds', async () => {
    const account = await registerAccount(harness);
    const resetUrl = (await forgot(account.email)).body.resetUrl!;
    await call('POST', '/api/v1/auth/password/reset', {
      body: { token: tokenFrom(resetUrl), password: 'a brand new passphrase' },
    });

    const refresh = await call('POST', '/api/v1/auth/refresh', {
      body: { refreshToken: account.refreshToken },
    });
    expect(refresh.status).toBe(401);
  });

  it('rejects an expired token without changing anything', async () => {
    const account = await registerAccount(harness);
    const resetUrl = (await forgot(account.email)).body.resetUrl!;
    await harness.db.execute('UPDATE password_resets SET expires_at = ?', [
      new Date(Date.now() - 60_000).toISOString(),
    ]);

    const response = await call('POST', '/api/v1/auth/password/reset', {
      body: { token: tokenFrom(resetUrl), password: 'a brand new passphrase' },
    });
    expect(response.status).toBe(401);

    const login = await call('POST', '/api/v1/auth/login', {
      body: { email: account.email, password: 'correct horse battery staple' },
    });
    expect(login.status).toBe(200);
  });

  it('changes a password with the current one, keeping only the caller session', async () => {
    const account = await registerAccount(harness);
    const second = await call<{ refreshToken: string; sessionId: string }>(
      'POST',
      '/api/v1/auth/login',
      { body: { email: account.email, password: 'correct horse battery staple' } },
    );

    const weak = await call('POST', '/api/v1/auth/password/change', {
      token: account.accessToken,
      body: { currentPassword: 'correct horse battery staple', newPassword: 'short' },
    });
    expect(weak.status).toBe(400);

    const wrong = await call('POST', '/api/v1/auth/password/change', {
      token: account.accessToken,
      body: { currentPassword: 'not the password', newPassword: 'a brand new passphrase' },
    });
    expect(wrong.status).toBe(401);

    const ok = await call<{ revokedSessions: number }>('POST', '/api/v1/auth/password/change', {
      token: account.accessToken,
      body: {
        currentPassword: 'correct horse battery staple',
        newPassword: 'a brand new passphrase',
        refreshToken: account.refreshToken,
      },
    });
    expect(ok.status).toBe(200);
    expect(ok.body.revokedSessions).toBe(1); // the second session only

    const stillMine = await call('POST', '/api/v1/auth/refresh', {
      body: { refreshToken: account.refreshToken },
    });
    expect(stillMine.status).toBe(200);

    const other = await call('POST', '/api/v1/auth/refresh', {
      body: { refreshToken: second.body.refreshToken },
    });
    expect(other.status).toBe(401);
  });

  it('lists sessions for the caller and revokes one of them', async () => {
    const account = await registerAccount(harness);
    await call('POST', '/api/v1/auth/login', {
      body: { email: account.email, password: 'correct horse battery staple' },
    });

    interface SessionRow {
      id: string;
      current: boolean;
      userAgent: string | null;
    }

    const list = await call<{ items: SessionRow[] }>('GET', '/api/v1/auth/sessions', {
      token: account.accessToken,
    });
    expect(list.status).toBe(200);
    expect(list.body.items).toHaveLength(2);
    // Nobody identified the current session, so none is marked: the desktop sends `?current=`.
    expect(list.body.items.some((item) => item.current)).toBe(false);

    const target = list.body.items[0];
    const revoked = await call('DELETE', `/api/v1/auth/sessions/${target.id}`, {
      token: account.accessToken,
    });
    expect(revoked.status).toBe(204);

    const after = await call<{ items: SessionRow[] }>('GET', '/api/v1/auth/sessions', {
      token: account.accessToken,
    });
    expect(after.body.items).toHaveLength(1);
  });

  it('marks the caller session when it identifies itself, and signs out everywhere', async () => {
    const login = await call<{ accessToken: string; refreshToken: string; sessionId: string }>(
      'POST',
      '/api/v1/auth/register',
      {
        body: {
          email: 'owner-sessions@example.com',
          password: 'correct horse battery staple',
          displayName: 'Owner',
          organisationName: 'Sessions Ltd',
        },
      },
    );
    const tokens = login.body;

    const list = await call<{ items: Array<{ current: boolean }> }>(
      'GET',
      `/api/v1/auth/sessions?current=${tokens.sessionId}`,
      { token: tokens.accessToken },
    );
    expect(list.body.items.filter((item) => item.current)).toHaveLength(1);

    const all = await call<{ revokedSessions: number }>('POST', '/api/v1/auth/logout-all', {
      token: tokens.accessToken,
    });
    expect(all.status).toBe(200);
    expect(all.body.revokedSessions).toBe(1);

    const refresh = await call('POST', '/api/v1/auth/refresh', {
      body: { refreshToken: tokens.refreshToken },
    });
    expect(refresh.status).toBe(401);
  });

  it('never lets one person revoke another person session', async () => {
    const alice = await registerAccount(harness, { email: 'alice@example.com' });
    const bob = await registerAccount(harness, { email: 'bob@example.com' });

    const bobSessions = await call<{ items: Array<{ id: string }> }>(
      'GET',
      '/api/v1/auth/sessions',
      { token: bob.accessToken },
    );
    const response = await call('DELETE', `/api/v1/auth/sessions/${bobSessions.body.items[0].id}`, {
      token: alice.accessToken,
    });
    expect(response.status).toBe(404);
  });
});
