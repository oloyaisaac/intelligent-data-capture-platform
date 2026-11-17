import { SMTPServer } from 'smtp-server';
import { loadConfig } from '../src/config';
import { createLogger } from '../src/logger';
import { createMailer, type Mailer } from '../src/services/mailer';
import { createHarness, registerAccount, type Harness } from './helpers';

describe('account email delivery', () => {
  it('delivers both link types over SMTP to a local test server', async () => {
    const messages: string[] = [];
    const server = new SMTPServer({
      authOptional: true,
      disabledCommands: ['AUTH', 'STARTTLS'],
      onData(stream, _session, callback) {
        let message = '';
        stream.setEncoding('utf8');
        stream.on('data', (chunk: string) => {
          message += chunk;
        });
        stream.on('end', () => {
          messages.push(message);
          callback();
        });
      },
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const address = server.server.address();
      if (!address || typeof address === 'string') throw new Error('SMTP fixture did not bind');
      const config = loadConfig({
        NODE_ENV: 'test',
        MAIL_TRANSPORT: 'smtp',
        MAIL_FROM: 'no-reply@example.com',
        SMTP_HOST: '127.0.0.1',
        SMTP_PORT: String(address.port),
        APP_ORIGIN: 'http://localhost:5173',
      });
      const mailer = createMailer(config)!;
      await mailer.sendPasswordReset(
        'person@example.com',
        'http://localhost:5173/#/reset-password?token=abc123',
      );
      await mailer.sendInvitation(
        'person@example.com',
        'http://localhost:5173/#/accept-invite?token=def456',
      );
      expect(messages).toHaveLength(2);
      expect(messages[0]).toContain('Subject: Reset your IDCP password');
      expect(messages[0]).toContain('token=abc123');
      expect(messages[1]).toContain('Subject: Your IDCP invitation');
      expect(messages[1]).toContain('token=def456');

      const productionMailer = createMailer(
        loadConfig({
          NODE_ENV: 'production',
          JWT_SECRET: 'x'.repeat(40),
          ENCRYPTION_KEY: 'y'.repeat(40),
          CORS_ORIGINS: 'https://app.example.com',
          APP_ORIGIN: 'https://app.example.com',
          MAIL_TRANSPORT: 'smtp',
          MAIL_FROM: 'no-reply@example.com',
          SMTP_HOST: '127.0.0.1',
          SMTP_PORT: String(address.port),
        }),
      )!;
      await expect(
        productionMailer.sendPasswordReset('person@example.com', 'https://app.example.com/#/reset'),
      ).rejects.toThrow();
      expect(messages).toHaveLength(2);
    } finally {
      await new Promise<void>((resolve) => server.close(resolve));
    }
  });

  it('validates SMTP settings and production link origins', () => {
    expect(() => loadConfig({ MAIL_TRANSPORT: 'smtp' })).toThrow(/SMTP_HOST/);
    expect(() =>
      loadConfig({
        MAIL_TRANSPORT: 'smtp',
        SMTP_HOST: 'mail.example.com',
        MAIL_FROM: 'mail@example.com',
        SMTP_USER: 'user',
      }),
    ).toThrow(/SMTP_PASSWORD/);
    expect(() =>
      loadConfig({
        NODE_ENV: 'production',
        JWT_SECRET: 'x'.repeat(40),
        ENCRYPTION_KEY: 'y'.repeat(40),
        CORS_ORIGINS: 'https://app.example.com',
        MAIL_TRANSPORT: 'smtp',
        SMTP_HOST: 'mail.example.com',
        MAIL_FROM: 'mail@example.com',
      }),
    ).toThrow(/APP_ORIGIN/);
  });

  it('never logs invitation tokens or query strings, including error paths', async () => {
    const lines: string[] = [];
    const logger = createLogger({ level: 'debug', sink: (line) => lines.push(line) });
    const harness = await createHarness({}, { logger });
    try {
      const token = 'one-time-invitation-secret-with-enough-characters';
      await harness.api.json('POST', `/api/v1/invitations/${token}/accept?token=another-secret`, {
        body: { password: 'a strong test password' },
      });
      await harness.api.get('/not-a-route?token=not-found-secret');
      const output = lines.join('\n');
      expect(output).toContain('/api/v1/invitations/:token/accept');
      expect(output).not.toContain(token);
      expect(output).not.toContain('another-secret');
      expect(output).not.toContain('not-found-secret');
    } finally {
      await harness.close();
    }
  });

  describe('production API', () => {
    let harness: Harness;
    const mailer: jest.Mocked<Mailer> = {
      sendPasswordReset: jest.fn(),
      sendInvitation: jest.fn(),
    };
    beforeEach(async () => {
      jest.clearAllMocks();
      harness = await createHarness(
        {
          NODE_ENV: 'production',
          JWT_SECRET: 'x'.repeat(40),
          ENCRYPTION_KEY: 'y'.repeat(40),
          CORS_ORIGINS: 'https://app.example.com',
          APP_ORIGIN: 'https://app.example.com',
        },
        { mailer },
      );
    });
    afterEach(async () => {
      await harness.close();
    });

    it('emails a reset link without exposing accounts or tokens in responses, and the link works once', async () => {
      const account = await registerAccount(harness);
      const known = await harness.api.json('POST', '/api/v1/auth/password/forgot', {
        body: { email: account.email },
      });
      const unknown = await harness.api.json('POST', '/api/v1/auth/password/forgot', {
        body: { email: 'missing@example.com' },
      });
      expect(known.statusCode).toBe(202);
      expect(known.body).toBe(unknown.body);
      expect(known.json()).toEqual({ accepted: true });
      expect(mailer.sendPasswordReset).toHaveBeenCalledTimes(1);
      const [recipient, link] = mailer.sendPasswordReset.mock.calls[0]!;
      expect(recipient).toBe(account.email);
      const token = new URLSearchParams(link.split('?')[1]).get('token');
      const response = await harness.api.json('POST', '/api/v1/auth/password/reset', {
        body: { token, password: 'a brand new passphrase' },
      });
      expect(response.statusCode).toBe(204);
      const replay = await harness.api.json('POST', '/api/v1/auth/password/reset', {
        body: { token, password: 'a different passphrase' },
      });
      expect(replay.statusCode).toBe(401);
    });

    it('returns the same reset response even if delivery fails', async () => {
      const account = await registerAccount(harness);
      mailer.sendPasswordReset.mockRejectedValueOnce(new Error('simulated provider outage'));
      const response = await harness.api.json('POST', '/api/v1/auth/password/forgot', {
        body: { email: account.email },
      });
      expect(response.statusCode).toBe(202);
      expect(response.json()).toEqual({ accepted: true });
    });

    it('sends the same one-time invitation link given to the administrator', async () => {
      const owner = await registerAccount(harness);
      const response = await harness.api.json('POST', '/api/v1/users/invite', {
        token: owner.accessToken,
        body: { email: 'invitee@example.com', role: 'reviewer' },
      });
      expect(response.statusCode).toBe(202);
      const body = response.json<{ invitation: { acceptUrl: string; token: string } }>();
      expect(mailer.sendInvitation).toHaveBeenCalledWith(
        'invitee@example.com',
        body.invitation.acceptUrl,
      );
      const accepted = await harness.api.json(
        'POST',
        `/api/v1/invitations/${body.invitation.token}/accept`,
        { body: { password: 'a good invitee passphrase' } },
      );
      expect(accepted.statusCode).toBe(200);
    });
  });
});
