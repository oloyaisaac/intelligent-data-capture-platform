import type { FastifyInstance } from 'fastify';
import {
  AcceptInviteRequestSchema,
  AppError,
  LoginRequestSchema,
  RefreshRequestSchema,
  RegisterRequestSchema,
  badRequest,
} from '@idcp/shared';
import type { Services } from '../../services/container';
import type { Guards } from '../guards';

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
}
