import type { FastifyInstance } from 'fastify';
import { CreateExportRequestSchema, badRequest } from '@idcp/shared';
import type { Services } from '../../services/container';
import type { Guards } from '../guards';

export function registerExportRoutes(
  app: FastifyInstance,
  services: Services,
  guards: Guards,
): void {
  app.post('/exports', async (request, reply) => {
    const actor = await guards.authenticate(request);
    const parsed = CreateExportRequestSchema.safeParse(request.body);
    if (!parsed.success) throw badRequest('Choose a format for the export.', parsed.error.issues);
    const result = await services.exports.create(actor, parsed.data);
    return reply.code(201).send(result);
  });

  app.get('/exports', async (request) => {
    const actor = await guards.authenticate(request);
    return { items: await services.exports.list(actor) };
  });

  app.get('/exports/:id', async (request) => {
    const actor = await guards.authenticate(request);
    return services.exports.get(actor, guards.uuidParam(request));
  });

  app.get('/exports/:id/download', async (request, reply) => {
    const actor = await guards.authenticate(request);
    const { buffer, mimeType, filename } = await services.exports.download(
      actor,
      guards.uuidParam(request),
    );
    reply.header('content-type', mimeType);
    reply.header('content-disposition', `attachment; filename="${filename}"`);
    reply.header('cache-control', 'private, no-store');
    return reply.send(buffer);
  });
}
