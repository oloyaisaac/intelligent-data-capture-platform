import type { FastifyInstance } from 'fastify';
import {
  AcceptInviteRequestSchema,
  AppError,
  ChangePasswordRequestSchema,
  ForgotPasswordRequestSchema,
  LoginRequestSchema,
  MfaConfirmRequestSchema,
  MfaDisableRequestSchema,
  MfaRecoveryRequestSchema,
  MfaStartRequestSchema,
  MfaVerifyRequestSchema,
  RefreshRequestSchema,
  RegisterRequestSchema,
  ResetPasswordRequestSchema,
  badRequest,
} from '@idcp/shared';
import type { Services } from '../../services/container';
import type { Guards } from '../guards';
import { isUuid } from '@idcp/shared/ids';

export function registerAuthRoutes(app: FastifyInstance, services: Services, guards: Guards): void {
  /**
   * TEAM-001 — accept an invitation link. Public, because the person accepting has no session yet;
   * the token itself is the credential. Single use and short-lived.
   */
  app.post('/invitations/:token/accept', async (request, reply) => {
    const parsed = AcceptInviteRequestSchema.safeParse({
      token: (request.params as Record<string, string>).token,
      password: (request.body as { password?: string } | undefined)?.password,
    });
    if (!parsed.success) throw badRequest('Choose a password with at least 12 characters.');

    const key = `invite-accept:${request.ip}`;
    if (!services.authLimiter.hit(key)) {
      throw new AppError('RATE_LIMITED', 'Too many attempts. Try again in a few minutes.');
    }

    const tokens = await services.auth.acceptInvitation(parsed.data, {
      ip: request.ip,
      userAgent: request.headers['user-agent'],
      ipHash: request.clientIpHash,
    });
    return reply.code(200).send(tokens);
  });

  app.post('/auth/register', async (request, reply) => {
    const parsed = RegisterRequestSchema.safeParse(request.body);
    if (!parsed.success) throw badRequest('Check the form and try again.', parsed.error.issues);
    if (!services.authLimiter.hit(`register:${request.ip}`)) {
      throw new AppError('RATE_LIMITED', 'Too many attempts. Try again in a few minutes.');
    }
    const tokens = await services.auth.register(parsed.data, {
      ip: request.ip,
      userAgent: request.headers['user-agent'],
    });
    return reply.code(201).send(tokens);
  });

  app.post('/auth/login', async (request, reply) => {
    const parsed = LoginRequestSchema.safeParse(request.body);
    if (!parsed.success) throw badRequest('Enter your email and password.');

    const key = `login:${request.ip}:${parsed.data.email}`;
    if (!services.authLimiter.hit(key)) {
      reply.header('Retry-After', String(services.authLimiter.retryAfterSeconds(key)));
      throw new AppError('RATE_LIMITED', 'Too many attempts. Wait a moment and try again.');
    }

    const tokens = await services.auth.login(parsed.data, {
      ip: request.ip,
      userAgent: request.headers['user-agent'],
    });
    services.authLimiter.reset(key);
    return reply.send(tokens);
  });

  app.post('/auth/refresh', async (request, reply) => {
    const parsed = RefreshRequestSchema.safeParse(request.body);
    if (!parsed.success) throw new AppError('UNAUTHENTICATED', 'Sign in again.');
    const tokens = await services.auth.refresh(parsed.data.refreshToken, {
      ip: request.ip,
      userAgent: request.headers['user-agent'],
    });
    return reply.send(tokens);
  });

  app.post('/auth/logout', async (request, reply) => {
    const parsed = RefreshRequestSchema.safeParse(request.body);
    if (parsed.success) await services.auth.logout(parsed.data.refreshToken);
    return reply.code(204).send();
  });

  app.get('/auth/me', async (request) => {
    const actor = await guards.authenticate(request);
    return services.auth.me(actor);
  });

  /** DEC-032: accounts older than the legal pack, or whose pack was revised, accept it here. */
  app.post('/auth/terms/accept', async (request) => {
    const actor = await guards.authenticate(request);
    return services.auth.acceptTerms(actor, {
      ip: request.ip,
      userAgent: request.headers['user-agent'],
      ipHash: request.clientIpHash,
    });
  });

  // --- Password reset (DEC-030) -------------------------------------------

  /**
   * Public, because the caller cannot sign in. The response never reveals whether the address
   * exists; outside production it carries the link so the flow can be finished without a mail
   * server (there is none in this deployment).
   */
  app.post('/auth/password/forgot', async (request, reply) => {
    const parsed = ForgotPasswordRequestSchema.safeParse(request.body);
    if (!parsed.success) throw badRequest('Enter the email address you signed up with.');

    const key = `forgot:${request.ip}`;
    if (!services.authLimiter.hit(key)) {
      reply.header('Retry-After', String(services.authLimiter.retryAfterSeconds(key)));
      throw new AppError('RATE_LIMITED', 'Too many requests. Wait a moment and try again.');
    }

    const result = await services.auth.requestPasswordReset(parsed.data.email);
    return reply.code(202).send(result);
  });

  app.post('/auth/password/reset', async (request, reply) => {
    const parsed = ResetPasswordRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      throw badRequest('Choose a password with at least 12 characters, then try again.');
    }
    const key = `reset:${request.ip}`;
    if (!services.authLimiter.hit(key)) {
      reply.header('Retry-After', String(services.authLimiter.retryAfterSeconds(key)));
      throw new AppError('RATE_LIMITED', 'Too many attempts. Wait a moment and try again.');
    }

    await services.auth.resetPassword(parsed.data.token, parsed.data.password);
    return reply.code(204).send();
  });

  app.post('/auth/password/change', async (request, reply) => {
    const actor = await guards.authenticate(request);
    const parsed = ChangePasswordRequestSchema.safeParse(request.body);
    if (!parsed.success) throw badRequest('Check the password fields and try again.');
    const result = await services.auth.changePassword(actor, parsed.data);
    return reply.send(result);
  });

  // --- Sessions ------------------------------------------------------------

  app.get('/auth/sessions', async (request) => {
    const actor = await guards.authenticate(request);
    const query = request.query as Record<string, string | undefined>;
    const items = await services.auth.listSessions(actor, query.current || undefined);
    return { items };
  });

  app.delete('/auth/sessions/:id', async (request, reply) => {
    const actor = await guards.authenticate(request);
    const id = (request.params as Record<string, string>).id;
    if (!isUuid(id)) throw new AppError('NOT_FOUND', 'That session is not active.');
    await services.auth.revokeSession(actor, id);
    return reply.code(204).send();
  });

  app.post('/auth/logout-all', async (request, reply) => {
    const actor = await guards.authenticate(request);
    const result = await services.auth.revokeAllSessions(actor);
    return reply.send(result);
  });

  // --- Multi-factor authentication (DEC-034) -------------------------------

  app.get('/auth/mfa', async (request) => {
    const actor = await guards.authenticate(request);
    return services.auth.mfaStatus(actor);
  });

  /** Step one: confirm the password and receive a secret that is not switched on yet. */
  app.post('/auth/mfa/enrol', async (request, reply) => {
    const actor = await guards.authenticate(request);
    const parsed = MfaStartRequestSchema.safeParse(request.body);
    if (!parsed.success) throw badRequest('Enter your password to start.');
    const key = `mfa-enrol:${actor.userId}`;
    if (!services.authLimiter.hit(key)) {
      throw new AppError('RATE_LIMITED', 'Too many attempts. Try again in a few minutes.');
    }
    const result = await services.auth.startMfaEnrolment(actor, parsed.data.password, {
      ip: request.ip,
      userAgent: request.headers['user-agent'],
      ipHash: request.clientIpHash,
    });
    return reply.send(result);
  });

  /** Step two: prove the app works, then the factor is on and the recovery codes are returned once. */
  app.post('/auth/mfa/enrol/confirm', async (request, reply) => {
    const actor = await guards.authenticate(request);
    const parsed = MfaConfirmRequestSchema.safeParse(request.body);
    if (!parsed.success) throw badRequest('Enter the 6-digit code from your authenticator app.');
    const key = `mfa-confirm:${actor.userId}`;
    if (!services.authLimiter.hit(key)) {
      throw new AppError('RATE_LIMITED', 'Too many attempts. Try again in a few minutes.');
    }
    const result = await services.auth.confirmMfaEnrolment(actor, parsed.data.code, {
      ip: request.ip,
      userAgent: request.headers['user-agent'],
      ipHash: request.clientIpHash,
    });
    services.authLimiter.reset(key);
    return reply.send(result);
  });

  /** The second half of a login. Anonymous: the challenge token is the only credential. */
  app.post('/auth/mfa/verify', async (request, reply) => {
    const parsed = MfaVerifyRequestSchema.safeParse(request.body);
    if (!parsed.success) throw badRequest('Enter the code from your authenticator app.');
    const key = `mfa-verify:${request.ip}`;
    if (!services.authLimiter.hit(key)) {
      reply.header('Retry-After', String(services.authLimiter.retryAfterSeconds(key)));
      throw new AppError('RATE_LIMITED', 'Too many attempts. Wait a moment and try again.');
    }
    const tokens = await services.auth.completeMfaLogin(
      parsed.data.challengeToken,
      parsed.data.code,
      {
        ip: request.ip,
        userAgent: request.headers['user-agent'],
        ipHash: request.clientIpHash,
      },
    );
    services.authLimiter.reset(key);
    return reply.send(tokens);
  });

  app.post('/auth/mfa/disable', async (request, reply) => {
    const actor = await guards.authenticate(request);
    const parsed = MfaDisableRequestSchema.safeParse(request.body);
    if (!parsed.success) throw badRequest('Enter your password and a current code.');
    await services.auth.disableMfa(actor, parsed.data.password, parsed.data.code, {
      ip: request.ip,
      ipHash: request.clientIpHash,
    });
    return reply.code(204).send();
  });

  app.post('/auth/mfa/recovery-codes', async (request, reply) => {
    const actor = await guards.authenticate(request);
    const parsed = MfaRecoveryRequestSchema.safeParse(request.body);
    if (!parsed.success) throw badRequest('Enter a current code from your authenticator app.');
    return reply.send(await services.auth.regenerateRecoveryCodes(actor, parsed.data.code));
  });
}
