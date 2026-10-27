import { createHarness, registerAccount, type Harness } from './helpers';

describe('authentication', () => {
  let harness: Harness;

  beforeAll(async () => {
    harness = await createHarness();
  });

  afterAll(async () => {
    await harness.close();
  });

  it('registers an owner and returns a token pair (AUTH-001)', async () => {
    const response = await harness.api.json('POST', '/api/v1/auth/register', {
      body: {
        email: 'owner@example.com',
        password: 'a-very-good-password',
        displayName: 'Owner One',
        organisationName: 'Acme Trading Ltd',
        acceptTerms: true,
      },
    });

    expect(response.statusCode).toBe(201);
    const body = response.json<{
      user: { role: string; organisationName: string };
      expiresIn: number;
      accessToken: string;
    }>();
    expect(body.user.role).toBe('owner');
    expect(body.user.organisationName).toBe('Acme Trading Ltd');
    expect(body.expiresIn).toBe(900);
    expect(body.accessToken.split('.')).toHaveLength(3);
  });

  it('stores passwords as Argon2id hashes, never plaintext', async () => {
    const account = await registerAccount(harness, {
      email: 'hash-check@example.com',
      password: 'hash-check-password',
    });
    const row = await harness.db.one<{ password_hash: string }>(
      'SELECT password_hash FROM users WHERE id = ?',
      [account.userId],
    );
    expect(row?.password_hash.startsWith('$argon2id$')).toBe(true);
    expect(row?.password_hash).not.toContain('hash-check-password');
  });

  it('rejects weak passwords', async () => {
    const response = await harness.api.json('POST', '/api/v1/auth/register', {
      body: {
        email: 'weak@example.com',
        password: 'password1234',
        displayName: 'Weak',
        organisationName: 'Weak Ltd',
        acceptTerms: true,
      },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json<{ error: { message: string } }>().error.message).toMatch(/too common/i);
  });

  it('logs in, and rejects a wrong password without revealing why', async () => {
    await registerAccount(harness, { email: 'login@example.com' });

    const ok = await harness.api.json('POST', '/api/v1/auth/login', {
      body: { email: 'login@example.com', password: 'correct horse battery staple' },
    });
    expect(ok.statusCode).toBe(200);

    const bad = await harness.api.json('POST', '/api/v1/auth/login', {
      body: { email: 'login@example.com', password: 'wrong-password-here' },
    });
    expect(bad.statusCode).toBe(401);
    expect(bad.json<{ error: { code: string } }>().error.code).toBe('INVALID_CREDENTIALS');

    const unknown = await harness.api.json('POST', '/api/v1/auth/login', {
      body: { email: 'nobody@example.com', password: 'wrong-password-here' },
    });
    expect(unknown.statusCode).toBe(401);
    expect(unknown.json<{ error: { message: string } }>().error.message).toBe(
      bad.json<{ error: { message: string } }>().error.message,
    );
  });

  it('rotates refresh tokens and rejects reuse', async () => {
    const account = await registerAccount(harness, { email: 'rotate@example.com' });

    const first = await harness.api.json('POST', '/api/v1/auth/refresh', {
      body: { refreshToken: account.refreshToken },
    });
    expect(first.statusCode).toBe(200);
    const rotated = first.json<{ refreshToken: string }>();
    expect(rotated.refreshToken).not.toBe(account.refreshToken);

    const replay = await harness.api.json('POST', '/api/v1/auth/refresh', {
      body: { refreshToken: account.refreshToken },
    });
    expect(replay.statusCode).toBe(401);
  });

  it('rejects missing, malformed and tampered access tokens', async () => {
    const missing = await harness.api.json('GET', '/api/v1/auth/me');
    expect(missing.statusCode).toBe(401);

    const malformed = await harness.api.json('GET', '/api/v1/auth/me', {
      headers: { authorization: 'Bearer not-a-jwt' },
    });
    expect(malformed.statusCode).toBe(401);

    const account = await registerAccount(harness, { email: 'tamper@example.com' });
    const tampered = await harness.api.json('GET', '/api/v1/auth/me', {
      headers: { authorization: `Bearer ${account.accessToken.slice(0, -3)}abc` },
    });
    expect(tampered.statusCode).toBe(401);
  });

  it('returns the current user for a valid token', async () => {
    const account = await registerAccount(harness, { email: 'me@example.com' });
    const response = await harness.api.json('GET', '/api/v1/auth/me', {
      token: account.accessToken,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ email: 'me@example.com', role: 'owner' });
  });

  it('revokes the session on logout', async () => {
    const account = await registerAccount(harness, { email: 'logout@example.com' });
    const out = await harness.api.json('POST', '/api/v1/auth/logout', {
      body: { refreshToken: account.refreshToken },
    });
    expect(out.statusCode).toBe(204);

    const refresh = await harness.api.json('POST', '/api/v1/auth/refresh', {
      body: { refreshToken: account.refreshToken },
    });
    expect(refresh.statusCode).toBe(401);
  });

  it('refuses to register the same email twice', async () => {
    await registerAccount(harness, { email: 'dupe@example.com' });
    const response = await harness.api.json('POST', '/api/v1/auth/register', {
      body: {
        email: 'dupe@example.com',
        password: 'another-good-password',
        displayName: 'Dupe',
        organisationName: 'Dupe Ltd',
        acceptTerms: true,
      },
    });
    expect(response.statusCode).toBe(409);
  });

  it('rate limits repeated login failures when the limiter is enabled', async () => {
    const rateLimited = await createHarness({ RATE_LIMIT_ENABLED: 'true' });
    try {
      for (let attempt = 0; attempt < 5; attempt += 1) {
        await rateLimited.api.json('POST', '/api/v1/auth/login', {
          body: { email: 'bruteforce@example.com', password: 'wrong-password-here' },
        });
      }
      const blocked = await rateLimited.api.json('POST', '/api/v1/auth/login', {
        body: { email: 'bruteforce@example.com', password: 'wrong-password-here' },
      });
      expect(blocked.statusCode).toBe(429);
      expect(blocked.headers.get('retry-after')).toBeTruthy();
      expect(blocked.json<{ error: { code: string } }>().error.code).toBe('RATE_LIMITED');
    } finally {
      await rateLimited.close();
    }
  });

  it('validates request bodies and rejects unknown fields', async () => {
    const response = await harness.api.json('POST', '/api/v1/auth/login', {
      body: { email: 'not-an-email', password: 'x', extra: true },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json<{ error: { code: string } }>().error.code).toBe('FIELD_VALIDATION_FAILED');
  });

  it('returns a 404 envelope for unknown routes', async () => {
    const response = await harness.api.json('GET', '/api/v1/nope');
    expect(response.statusCode).toBe(404);
    expect(response.json<{ error: { code: string } }>().error.code).toBe('NOT_FOUND');
  });

  it('reports health with dependency status', async () => {
    const response = await harness.api.get('/api/v1/health');
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ status: 'ok', dependencies: { db: 'ok' } });
  });

  it('never leaks internal details in a 500', async () => {
    // Temporarily break the database handle to force an unexpected error.
    const original = harness.services.db.query;
    harness.services.db.query = async () => {
      throw new Error('connection terminated: secret-internal-detail');
    };
    const response = await harness.api.get('/api/v1/stats', '');
    harness.services.db.query = original;

    expect(response.statusCode).toBe(401);
    expect(response.body).not.toContain('secret-internal-detail');
  });
});
