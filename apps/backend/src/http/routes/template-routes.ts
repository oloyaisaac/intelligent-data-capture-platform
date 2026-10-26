import type { FastifyInstance } from 'fastify';
import {
  CreateTemplateRequestSchema,
  DOCUMENT_TYPES,
  UpdateTemplateRequestSchema,
  badRequest,
  type DocumentType,
} from '@idcp/shared';
import type { Services } from '../../services/container';
import type { Guards } from '../guards';

export function registerTemplateRoutes(
  app: FastifyInstance,
  services: Services,
  guards: Guards,
): void {
  /** TPL-001 — list templates, optionally filtered by document type. */
  app.get('/templates', async (request) => {
    const actor = await guards.authenticate(request);
    const query = request.query as { documentType?: string };
    const documentType =
      query.documentType && (DOCUMENT_TYPES as readonly string[]).includes(query.documentType)
        ? (query.documentType as DocumentType)
        : undefined;
    return { items: await services.templates.list(actor, documentType) };
  });

  app.post('/templates', async (request, reply) => {
    const actor = await guards.authenticate(request);
    const parsed = CreateTemplateRequestSchema.safeParse(request.body);
    if (!parsed.success)
      throw badRequest('Those template details are not valid.', parsed.error.issues);
    const template = await services.templates.create(actor, parsed.data);
    return reply.code(201).send(template);
  });

  app.get('/templates/:id', async (request) => {
    const actor = await guards.authenticate(request);
    return services.templates.get(actor, guards.uuidParam(request));
  });

  app.patch('/templates/:id', async (request) => {
    const actor = await guards.authenticate(request);
    const parsed = UpdateTemplateRequestSchema.safeParse(request.body);
    if (!parsed.success)
      throw badRequest('Those template changes are not valid.', parsed.error.issues);
    return services.templates.update(actor, guards.uuidParam(request), parsed.data);
  });

  /** Disabling a template never deletes it: past versions and extractions stay explainable. */
  app.delete('/templates/:id', async (request, reply) => {
    const actor = await guards.authenticate(request);
    await services.templates.disable(actor, guards.uuidParam(request));
    return reply.code(204).send();
  });
}
