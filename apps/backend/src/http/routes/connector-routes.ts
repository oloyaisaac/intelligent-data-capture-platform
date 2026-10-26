import type { FastifyInstance } from 'fastify';
import {
  CreateConnectorRequestSchema,
  CreateMappingProfileRequestSchema,
  SendDocumentRequestSchema,
  badRequest,
} from '@idcp/shared';
import type { Services } from '../../services/container';
import type { Guards } from '../guards';

export function registerConnectorRoutes(
  app: FastifyInstance,
  services: Services,
  guards: Guards,
): void {
  app.get('/connectors/types', async (request) => {
    await guards.authenticate(request);
    return { items: services.connectors.listTypes() };
  });

  app.get('/connectors', async (request) => {
    const actor = await guards.authenticate(request);
    return { items: await services.connectors.list(actor) };
  });

  app.post('/connectors', async (request, reply) => {
    const actor = await guards.authenticate(request);
    await guards.requireRole('admin')(request, reply);
    const parsed = CreateConnectorRequestSchema.safeParse(request.body);
    if (!parsed.success)
      throw badRequest('That connector configuration is not valid.', parsed.error.issues);
    const created = await services.connectors.create(actor, parsed.data);
    return reply.code(201).send(created);
  });

  app.patch('/connectors/:id', async (request, reply) => {
    const actor = await guards.authenticate(request);
    await guards.requireRole('admin')(request, reply);
    const body = request.body as { name?: unknown; config?: unknown; status?: unknown };
    return services.connectors.update(actor, guards.uuidParam(request), {
      name: typeof body?.name === 'string' ? body.name : undefined,
      config:
        body?.config && typeof body.config === 'object'
          ? (body.config as Record<string, unknown>)
          : undefined,
      status: body?.status === 'active' || body?.status === 'disabled' ? body.status : undefined,
    });
  });

  app.delete('/connectors/:id', async (request, reply) => {
    const actor = await guards.authenticate(request);
    await guards.requireRole('admin')(request, reply);
    await services.connectors.remove(actor, guards.uuidParam(request));
    return reply.code(204).send();
  });

  app.post('/connectors/:id/test', async (request) => {
    const actor = await guards.authenticate(request);
    return services.connectors.test(actor, guards.uuidParam(request));
  });

  app.get('/connectors/:id/schema', async (request) => {
    const actor = await guards.authenticate(request);
    return services.connectors.describeSchema(actor, guards.uuidParam(request));
  });

  app.get('/connectors/:id/runs', async (request) => {
    const actor = await guards.authenticate(request);
    return { items: await services.connectors.listRuns(actor, guards.uuidParam(request)) };
  });

  app.get('/mapping-profiles', async (request) => {
    const actor = await guards.authenticate(request);
    return { items: await services.connectors.listMappings(actor) };
  });

  app.post('/mapping-profiles', async (request, reply) => {
    const actor = await guards.authenticate(request);
    await guards.requireRole('reviewer')(request, reply);
    const parsed = CreateMappingProfileRequestSchema.safeParse(request.body);
    if (!parsed.success) throw badRequest('That mapping is not valid.', parsed.error.issues);
    const created = await services.connectors.createMapping(actor, parsed.data);
    return reply.code(201).send(created);
  });

  app.post('/documents/:id/send', async (request, reply) => {
    const actor = await guards.authenticate(request);
    const parsed = SendDocumentRequestSchema.safeParse(request.body);
    if (!parsed.success) throw badRequest('Choose a connector and a mapping profile.');
    const result = await services.connectors.sendDocument(
      actor,
      guards.uuidParam(request),
      parsed.data.connectorId,
      parsed.data.mappingProfileId,
    );
    return reply.code(202).send(result);
  });
}
