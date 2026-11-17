import { totp } from '../src/auth/totp';
import { createHarness, registerAccount, type Harness } from './helpers';

/**
 * Two-factor authentication (DEC-034).
 *
 * The properties that matter: a password alone stops being enough the moment a factor is enrolled,
 * the secret is never returned twice, recovery codes work exactly once, and turning the factor off
 * needs both the password and a live code — otherwise "disable MFA" is the weakest link in the chain.
 */
describe('multi-factor authentication', () => {
  let harness: Harness;

  beforeEach(async () => {
    harness = await createHarness();
  });

  afterEach(async () => {
    await harness.close();
  });

  const password = 'correct horse battery staple';

  async function enrol(account: { accessToken: string }) {
    const start = await harness.api.json('POST', '/api/v1/auth/mfa/enrol', {
      token: account.accessToken,
      body: { password },
    });
    expect(start.statusCode).toBe(200);
    const secret = start.json<{ secret: string; otpauthUri: string }>();
    const confirm = await harness.api.json('POST', '/api/v1/auth/mfa/enrol/confirm', {
      token: account.accessToken,
      body: { code: totp(secret.secret) },
    });
    expect(confirm.statusCode).toBe(200);
    return {
      secret: secret.secret,
      otpauthUri: secret.otpauthUri,
      recoveryCodes: confirm.json<{ recoveryCodes: string[] }>().recoveryCodes,
    };
  }

  it('starts enrolment only with the password and does not enable anything yet', async () => {
    const account = await registerAccount(harness);

    const wrong = await harness.api.json('POST', '/api/v1/auth/mfa/enrol', {
      token: account.accessToken,
      body: { password: 'not the password' },
    });
    expect(wrong.statusCode).toBe(401);

    const start = await harness.api.json('POST', '/api/v1/auth/mfa/enrol', {
      token: account.accessToken,
      body: { password },
    });
    expect(start.statusCode).toBe(200);
    expect(start.json<{ otpauthUri: string }>().otpauthUri).toContain('otpauth://totp/');

    // Nothing is switched on until a code proves the app is set up.
    const status = await harness.api.json('GET', '/api/v1/auth/mfa', {
      token: account.accessToken,
    });
    expect(status.json<{ enabled: boolean }>().enabled).toBe(false);
  });

  it('enables MFA and hands out recovery codes exactly once', async () => {
    const account = await registerAccount(harness);
    const { recoveryCodes } = await enrol(account);

    expect(recoveryCodes).toHaveLength(10);
    const status = await harness.api.json('GET', '/api/v1/auth/mfa', {
      token: account.accessToken,
    });
    const body = status.json<{ enabled: boolean; recoveryCodesRemaining: number }>();
    expect(body.enabled).toBe(true);
    expect(body.recoveryCodesRemaining).toBe(10);

    // The codes are stored hashed: the row must not contain the plaintext.
    const row = await harness.db.one<{ mfa_secret_enc: string; mfa_recovery_hashes: string }>(
      'SELECT mfa_secret_enc, mfa_recovery_hashes FROM users WHERE id = ?',
      [account.userId],
    );
    expect(row!.mfa_secret_enc).not.toContain(recoveryCodes[0]!);
    expect(row!.mfa_recovery_hashes).not.toContain(recoveryCodes[0]!);
    // ... and the TOTP secret is encrypted, not stored in the clear.
    expect(row!.mfa_secret_enc).toMatch(/^v1:/);
  });

  it('refuses to confirm enrolment with the wrong code', async () => {
    const account = await registerAccount(harness);
    const start = await harness.api.json('POST', '/api/v1/auth/mfa/enrol', {
      token: account.accessToken,
      body: { password },
    });
    const { secret } = start.json<{ secret: string }>();
    const wrong = await harness.api.json('POST', '/api/v1/auth/mfa/enrol/confirm', {
      token: account.accessToken,
      body: { code: totp(secret) === '000000' ? '000001' : '000000' },
    });
    expect(wrong.statusCode).toBe(422);
  });

  it('turns login into two steps once MFA is on', async () => {
    const account = await registerAccount(harness);
    const { secret } = await enrol(account);

    const login = await harness.api.json('POST', '/api/v1/auth/login', {
      body: { email: account.email, password },
    });
    expect(login.statusCode).toBe(200);
    const challenge = login.json<{ mfaRequired: true; challengeToken: string }>();
    expect(challenge.mfaRequired).toBe(true);
    // No tokens in the first response: the password alone is not a session.
    expect(login.json<Record<string, unknown>>().accessToken).toBeUndefined();

    const wrongCode = await harness.api.json('POST', '/api/v1/auth/mfa/verify', {
      body: { challengeToken: challenge.challengeToken, code: '000000' },
    });
    expect(wrongCode.statusCode).toBe(422);

    const verified = await harness.api.json('POST', '/api/v1/auth/mfa/verify', {
      body: { challengeToken: challenge.challengeToken, code: totp(secret) },
    });
    expect(verified.statusCode).toBe(200);
    expect(verified.json<{ accessToken: string }>().accessToken).toBeTruthy();
  });

  it.each([null, 'corrupted-ciphertext'])(
    'never bypasses an enabled factor when its encrypted secret is %s',
    async (storedSecret) => {
      const account = await registerAccount(harness);
      const { recoveryCodes } = await enrol(account);
      await harness.db.execute('UPDATE users SET mfa_secret_enc = ? WHERE id = ?', [
        storedSecret,
        account.userId,
      ]);
      const login = await harness.api.json('POST', '/api/v1/auth/login', {
        body: { email: account.email, password },
      });
      expect(login.statusCode).toBe(200);
      const challenge = login.json<{
        mfaRequired: boolean;
        challengeToken: string;
        accessToken?: string;
      }>();
      expect(challenge.mfaRequired).toBe(true);
      expect(challenge.accessToken).toBeUndefined();
      const recovery = await harness.api.json('POST', '/api/v1/auth/mfa/verify', {
        body: { challengeToken: challenge.challengeToken, code: recoveryCodes[0] },
      });
      expect(recovery.statusCode).toBe(200);
    },
  );

  it('rejects a challenge token that was not issued for MFA', async () => {
    const account = await registerAccount(harness);
    const response = await harness.api.json('POST', '/api/v1/auth/mfa/verify', {
      body: { challengeToken: account.accessToken, code: '123456' },
    });
    // An access token is signed for a different audience and carries no mfa scope.
    expect(response.statusCode).toBe(401);
  });

  it('accepts a recovery code once and then not again', async () => {
    const account = await registerAccount(harness);
    const { recoveryCodes } = await enrol(account);

    const first = await harness.api.json('POST', '/api/v1/auth/login', {
      body: { email: account.email, password },
    });
    const challenge = first.json<{ challengeToken: string }>();
    const used = await harness.api.json('POST', '/api/v1/auth/mfa/verify', {
      body: { challengeToken: challenge.challengeToken, code: recoveryCodes[0]! },
    });
    expect(used.statusCode).toBe(200);

    const second = await harness.api.json('POST', '/api/v1/auth/login', {
      body: { email: account.email, password },
    });
    const again = await harness.api.json('POST', '/api/v1/auth/mfa/verify', {
      body: {
        challengeToken: second.json<{ challengeToken: string }>().challengeToken,
        code: recoveryCodes[0]!,
      },
    });
    expect(again.statusCode).toBe(422);

    const status = await harness.api.json('GET', '/api/v1/auth/mfa', {
      token: account.accessToken,
    });
    expect(status.json<{ recoveryCodesRemaining: number }>().recoveryCodesRemaining).toBe(9);
  });

  it('needs the password and a code to turn the factor off', async () => {
    const account = await registerAccount(harness);
    const { secret } = await enrol(account);

    const noPassword = await harness.api.json('POST', '/api/v1/auth/mfa/disable', {
      token: account.accessToken,
      body: { password: 'wrong password entirely', code: totp(secret) },
    });
    expect(noPassword.statusCode).toBe(401);

    const noCode = await harness.api.json('POST', '/api/v1/auth/mfa/disable', {
      token: account.accessToken,
      body: { password, code: '000000' },
    });
    expect(noCode.statusCode).toBe(422);

    const disabled = await harness.api.json('POST', '/api/v1/auth/mfa/disable', {
      token: account.accessToken,
      body: { password, code: totp(secret) },
    });
    expect(disabled.statusCode).toBe(204);

    // Back to one step.
    const login = await harness.api.json('POST', '/api/v1/auth/login', {
      body: { email: account.email, password },
    });
    expect(login.json<Record<string, unknown>>().accessToken).toBeTruthy();
  });

  it('regenerates recovery codes behind a live code', async () => {
    const account = await registerAccount(harness);
    const { secret, recoveryCodes } = await enrol(account);

    const response = await harness.api.json('POST', '/api/v1/auth/mfa/recovery-codes', {
      token: account.accessToken,
      body: { code: totp(secret) },
    });
    expect(response.statusCode).toBe(200);
    const fresh = response.json<{ recoveryCodes: string[] }>().recoveryCodes;
    expect(fresh).toHaveLength(10);
    expect(fresh).not.toEqual(recoveryCodes);
  });
});
