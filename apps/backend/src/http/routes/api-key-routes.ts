import type { FastifyInstance } from 'fastify';
import { CreateApiKeyRequestSchema, badRequest } from '@idcp/shared';
import type { Services } from '../../services/container';
import type { Guards } from '../guards';

export function registerApiKeyRoutes(
  app: FastifyInstance,
  services: Services,
  guards: Guards,
): void {
  /** DEVAPI-001 — the only endpoint that ever returns a key secret, and only once. */
  app.post('/api-keys', async (request, reply) => {
    const actor = await guards.authenticate(request);
    const parsed = CreateApiKeyRequestSchema.safeParse(request.body);
    if (!parsed.success)
      throw badRequest('Those API key details are not valid.', parsed.error.issues);
    const created = await services.apiKeys.create(actor, parsed.data);
    return reply.code(201).send(created);
  });

  app.get('/api-keys', async (request) => {
    const actor = await guards.authenticate(request);
    return { items: await services.apiKeys.list(actor) };
  });

  app.delete('/api-keys/:id', async (request) => {
    const actor = await guards.authenticate(request);
    return services.apiKeys.revoke(actor, guards.uuidParam(request));
  });
}
