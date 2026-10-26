import type { FastifyInstance } from 'fastify';
import {
  BulkApproveRequestSchema,
  PatchFieldsRequestSchema,
  RejectRequestSchema,
  badRequest,
} from '@idcp/shared';
import type { Services } from '../../services/container';
import type { Guards } from '../guards';

export function registerReviewRoutes(
  app: FastifyInstance,
  services: Services,
  guards: Guards,
): void {
  /** REV-001 — queue of documents needing a human, least confident first. */
  app.get('/review/queue', async (request) => {
    const actor = await guards.authenticate(request);
    const query = request.query as { limit?: string };
    const limit = Math.min(Number(query.limit ?? 25) || 25, 100);
    return services.reviews.queue(actor, limit);
  });

  app.post('/documents/:id/review', async (request, reply) => {
    const actor = await guards.authenticate(request);
    const result = await services.reviews.open(actor, guards.uuidParam(request));
    return reply.send(result);
  });

  app.patch('/review/:id/fields', async (request) => {
    const actor = await guards.authenticate(request);
    const parsed = PatchFieldsRequestSchema.safeParse(request.body);
    if (!parsed.success)
      throw badRequest('Those field changes are not valid.', parsed.error.issues);
    return services.reviews.patchFields(actor, guards.uuidParam(request), parsed.data.changes, {
      documentType: parsed.data.documentType,
    });
  });

  app.post('/review/:id/approve', async (request) => {
    const actor = await guards.authenticate(request);
    const body = request.body as { notes?: unknown } | undefined;
    const notes = typeof body?.notes === 'string' ? body.notes.slice(0, 2000) : undefined;
    return services.reviews.approve(actor, guards.uuidParam(request), notes);
  });

  app.post('/review/:id/reject', async (request) => {
    const actor = await guards.authenticate(request);
    const parsed = RejectRequestSchema.safeParse(request.body);
    if (!parsed.success) throw badRequest('Give a reason for rejecting this record.');
    return services.reviews.reject(actor, guards.uuidParam(request), parsed.data.reason);
  });

  app.post('/review/bulk-approve', async (request) => {
    const actor = await guards.authenticate(request);
    const parsed = BulkApproveRequestSchema.safeParse(request.body);
    if (!parsed.success) throw badRequest('Select the records to approve.');
    return services.reviews.bulkApprove(actor, parsed.data.documentIds);
  });
}
