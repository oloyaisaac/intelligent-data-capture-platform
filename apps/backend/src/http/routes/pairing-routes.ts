import type { FastifyInstance } from 'fastify';
import { CompletePairingRequestSchema, badRequest } from '@idcp/shared';
import type { Services } from '../../services/container';
import type { Guards } from '../guards';

export function registerPairingRoutes(
  app: FastifyInstance,
  services: Services,
  guards: Guards,
): void {
  /** PAIR-001 — desktop asks for a QR payload. */
  app.post('/pairing/sessions', async (request, reply) => {
    const actor = await guards.authenticate(request);
    if (!services.pairingLimiter.hit(`pairing:${actor.userId}`)) {
      throw badRequest('Too many pairing attempts. Wait a minute and try again.');
    }
    const session = await services.pairing.createSession(actor);
    return reply.code(201).send(session);
  });

  app.get('/pairing/sessions/:id', async (request) => {
    const actor = await guards.authenticate(request);
    const id = guards.uuidParam(request);
    return services.pairing.getSession(actor, id);
  });

  /** PAIR-002 — the phone completes pairing. Public by design: the token *is* the credential. */
  app.post('/pairing/complete', async (request, reply) => {
    const parsed = CompletePairingRequestSchema.safeParse(request.body);
    if (!parsed.success) throw badRequest('That pairing request is missing information.');

    if (!services.authLimiter.hit(`pair-complete:${request.ip}`)) {
      const retry = services.authLimiter.retryAfterSeconds(`pair-complete:${request.ip}`);
      reply.header('Retry-After', String(retry));
      throw badRequest('Too many attempts. Try again shortly.');
    }

    const result = await services.pairing.complete(parsed.data, { ip: request.ip });
    return reply.code(201).send(result);
  });

  app.get('/devices', async (request) => {
    const actor = await guards.authenticate(request);
    return { items: await services.pairing.listDevices(actor) };
  });

  app.patch('/devices/:id', async (request) => {
    const actor = await guards.authenticate(request);
    const id = guards.uuidParam(request);
    const body = request.body as { name?: unknown };
    const name = typeof body?.name === 'string' ? body.name.trim() : '';
    if (name.length < 1 || name.length > 80)
      throw badRequest('Give the device a name of 1–80 characters.');
    return services.pairing.rename(actor, id, name);
  });

  /** PAIR-004 — revocation is immediate. */
  app.delete('/devices/:id', async (request, reply) => {
    const actor = await guards.authenticate(request);
    const id = guards.uuidParam(request);
    await services.pairing.revoke(actor, id);
    return reply.code(204).send();
  });
}
