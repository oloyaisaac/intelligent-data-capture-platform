import type { FastifyInstance } from 'fastify';
import { CreateProjectRequestSchema, UpdateProjectRequestSchema, badRequest } from '@idcp/shared';
import type { Services } from '../../services/container';
import type { Guards } from '../guards';

/** TEAM-001 — projects group documents and batches inside one organisation. */
export function registerProjectRoutes(
  app: FastifyInstance,
  services: Services,
  guards: Guards,
): void {
  app.get('/projects', async (request) => {
    const actor = await guards.authenticate(request);
    const query = request.query as Record<string, string | undefined>;
    return { items: await services.projects.list(actor, query.includeArchived === 'true') };
  });

  app.post('/projects', async (request, reply) => {
    const actor = await guards.authenticate(request);
    const parsed = CreateProjectRequestSchema.safeParse(request.body);
    if (!parsed.success) throw badRequest('Give the project a name.', parsed.error.issues);
    const project = await services.projects.create(actor, parsed.data);
    return reply.code(201).send(project);
  });

  app.patch('/projects/:id', async (request) => {
    const actor = await guards.authenticate(request);
    const parsed = UpdateProjectRequestSchema.safeParse(request.body);
    if (!parsed.success) throw badRequest('That project change is not valid.', parsed.error.issues);
    return services.projects.update(actor, guards.uuidParam(request), parsed.data);
  });

  app.delete('/projects/:id', async (request, reply) => {
    const actor = await guards.authenticate(request);
    await services.projects.archive(actor, guards.uuidParam(request));
    return reply.code(204).send();
  });
}
