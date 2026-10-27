import { LEGAL_VERSION } from '@idcp/shared';
import { createHarness, registerAccount, type Harness } from './helpers';

/**
 * Acceptance of the legal pack (DEC-032).
 *
 * The point of the feature is evidence, so these tests are about what can be proved afterwards:
 * that an account cannot exist without accepting, that the record carries the version that was
 * accepted, and that a revised pack is visible as "not current" rather than silently assumed.
 */
describe('terms acceptance', () => {
  let harness: Harness;

  beforeEach(async () => {
    harness = await createHarness();
  });

  afterEach(async () => {
    await harness.close();
  });

  const registerBody = (email: string) => ({
    email,
    password: 'correct horse battery staple',
    displayName: 'Owner',
    organisationName: 'Terms Ltd',
  });

  it('refuses to create an account when the terms were not accepted', async () => {
    const response = await harness.api.json('POST', '/api/v1/auth/register', {
      body: registerBody('no-terms@example.com'),
    });
    expect(response.statusCode).toBe(400);

    const rejected = await harness.api.json('POST', '/api/v1/auth/register', {
      body: { ...registerBody('said-no@example.com'), acceptTerms: false },
    });
    expect(rejected.statusCode).toBe(400);

    const rows = await harness.db.query('SELECT id FROM users WHERE email = ?', [
      'no-terms@example.com',
    ]);
    expect(rows).toHaveLength(0);
  });

  it('records the version that was accepted, and reports it on /auth/me', async () => {
    const account = await registerAccount(harness);

    const me = await harness.api.json('GET', '/api/v1/auth/me', { token: account.accessToken });
    expect(me.statusCode).toBe(200);
    const body = me.json<{
      terms: { acceptedAt: string | null; version: string | null; current: boolean };
    }>();
    expect(body.terms.version).toBe(LEGAL_VERSION);
    expect(body.terms.acceptedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(body.terms.current).toBe(true);

    // The same fact is in the row, so a contract can be proved without trusting the API response.
    const row = await harness.db.one<{ terms_version: string | null; terms_accepted_at: string }>(
      'SELECT terms_version, terms_accepted_at FROM users WHERE id = ?',
      [account.userId],
    );
    expect(row?.terms_version).toBe(LEGAL_VERSION);
    expect(row?.terms_accepted_at).toBe(body.terms.acceptedAt);
  });

  it('asks an account older than the pack to accept, and records it when they do', async () => {
    const account = await registerAccount(harness);
    // Stand in for an account created before the legal pack existed.
    await harness.db.execute(
      'UPDATE users SET terms_accepted_at = NULL, terms_version = NULL WHERE id = ?',
      [account.userId],
    );

    const before = await harness.api.json('GET', '/api/v1/auth/me', { token: account.accessToken });
    expect(before.json<{ terms: { current: boolean } }>().terms.current).toBe(false);

    const accepted = await harness.api.json('POST', '/api/v1/auth/terms/accept', {
      token: account.accessToken,
    });
    expect(accepted.statusCode).toBe(200);
    expect(accepted.json<{ current: boolean }>().current).toBe(true);

    const after = await harness.api.json('GET', '/api/v1/auth/me', { token: account.accessToken });
    expect(after.json<{ terms: { current: boolean } }>().terms.current).toBe(true);

    // Accepting is a legal event, so it is in the audit trail like any other privileged action.
    const entry = await harness.db.one<{ action: string; metadata: string }>(
      `SELECT action, metadata FROM audit_logs WHERE action = 'legal.terms_accepted' AND actor_id = ?`,
      [account.userId],
    );
    expect(entry?.action).toBe('legal.terms_accepted');
    expect(JSON.parse(entry!.metadata)).toMatchObject({ version: LEGAL_VERSION });
  });

  it('treats an account that accepted an older version as not current', async () => {
    const account = await registerAccount(harness);
    await harness.db.execute('UPDATE users SET terms_version = ? WHERE id = ?', [
      '2020-01',
      account.userId,
    ]);

    const me = await harness.api.json('GET', '/api/v1/auth/me', { token: account.accessToken });
    const terms = me.json<{ terms: { current: boolean; version: string } }>().terms;
    expect(terms.current).toBe(false);
    // The old version is still reported: the record says "accepted 2020-01", not "nothing".
    expect(terms.version).toBe('2020-01');
  });

  it('requires a session to accept', async () => {
    const response = await harness.api.json('POST', '/api/v1/auth/terms/accept');
    expect(response.statusCode).toBe(401);
  });
});
