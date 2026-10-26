import type { FastifyInstance } from 'fastify';
import {
  CreateBatchRequestSchema,
  DOCUMENT_TYPES,
  badRequest,
  type DocumentType,
} from '@idcp/shared';
import type { Services } from '../../services/container';
import type { Guards } from '../guards';
import type { BatchFile } from '../../services/batch-service';

/**
 * BATCH-001 — one request, many files.
 *
 * Multipart fields that arrive before any file describe the batch (`name`, `projectId`,
 * `documentType`); every file part after them is one batch item. Partial success is the normal
 * case, so the response is always 201 with per-item results.
 */
export function registerBatchRoutes(
  app: FastifyInstance,
  services: Services,
  guards: Guards,
): void {
  app.post('/batches', async (request, reply) => {
    const actor = await guards.authenticate(request);
    if (!request.isMultipart()) throw badRequest('Upload the files as multipart/form-data.');

    const files: BatchFile[] = [];
    const fields: Record<string, string> = {};

    for await (const part of request.parts()) {
      if (part.type === 'file') {
        files.push({ buffer: await part.toBuffer(), filename: part.filename });
      } else if (typeof part.value === 'string') {
        fields[part.fieldname] = part.value;
      }
    }

    const documentTypeRaw = fields.documentType;
    const parsed = CreateBatchRequestSchema.safeParse({
      name: fields.name,
      projectId: fields.projectId || undefined,
      documentType:
        documentTypeRaw && (DOCUMENT_TYPES as readonly string[]).includes(documentTypeRaw)
          ? (documentTypeRaw as DocumentType)
          : undefined,
    });
    if (!parsed.success) throw badRequest('Check the batch details.', parsed.error.issues);

    const batch = await services.batches.create(actor, { ...parsed.data, files });
    return reply.code(201).send(batch);
  });

  app.get('/batches', async (request) => {
    const actor = await guards.authenticate(request);
    const query = request.query as Record<string, string | undefined>;
    return { items: await services.batches.list(actor, Number(query.limit ?? 25) || 25) };
  });

  app.get('/batches/:id', async (request) => {
    const actor = await guards.authenticate(request);
    return services.batches.get(actor, guards.uuidParam(request));
  });

  /** Progress is derived from the documents, never stored, so polling this is always truthful. */
  app.get('/batches/:id/items', async (request) => {
    const actor = await guards.authenticate(request);
    const batch = await services.batches.get(actor, guards.uuidParam(request));
    return {
      batchId: batch.id,
      total: batch.total,
      processed: batch.processed,
      succeeded: batch.succeeded,
      failed: batch.failed,
      status: batch.status,
      items: batch.items,
    };
  });

  app.get('/batches/:id/results.csv', async (request, reply) => {
    const actor = await guards.authenticate(request);
    const { filename, body } = await services.batches.exportCsv(actor, guards.uuidParam(request));
    reply.header('content-type', 'text/csv; charset=utf-8');
    reply.header('content-disposition', `attachment; filename="${filename}"`);
    reply.header('cache-control', 'private, no-store');
    return reply.send(body);
  });
}
