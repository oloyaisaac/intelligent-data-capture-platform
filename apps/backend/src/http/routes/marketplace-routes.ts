import type { FastifyInstance } from 'fastify';
import { badRequest } from '@idcp/shared';
import type { Services } from '../../services/container';
import type { Guards } from '../guards';

/** MARKET-001 — the reviewed connector catalogue and its install history. */
export function registerMarketplaceRoutes(
  app: FastifyInstance,
  services: Services,
  guards: Guards,
): void {
  app.get('/marketplace', async (request) => {
    const actor = await guards.authenticate(request);
    return services.marketplace.list(actor);
  });

  app.post('/marketplace/install', async (request, reply) => {
    const actor = await guards.authenticate(request);
    await guards.requireRole('admin')(request, reply);
    const body = request.body as {
      packageId?: unknown;
      connectorId?: unknown;
      version?: unknown;
    };
    if (typeof body?.packageId !== 'string' || typeof body?.connectorId !== 'string') {
      throw badRequest('Choose a package and the connector it should be installed on.');
    }
    const install = await services.marketplace.install(actor, {
      packageId: body.packageId,
      connectorId: body.connectorId,
      ...(typeof body.version === 'string' && body.version ? { version: body.version } : {}),
    });
    return reply.code(201).send(install);
  });

  app.post('/marketplace/installs/:id/rollback', async (request, reply) => {
    const actor = await guards.authenticate(request);
    await guards.requireRole('admin')(request, reply);
    return services.marketplace.rollback(actor, guards.uuidParam(request));
  });
}
