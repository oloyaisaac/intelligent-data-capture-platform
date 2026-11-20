import type { FastifyInstance } from 'fastify';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CreateBatchRequestSchema,
  DOCUMENT_TYPES,
  badRequest,
  type DocumentType,
} from '@idcp/shared';
import type { Services } from '../../services/container';
import type { Guards } from '../guards';
import type { BatchFile } from '../../services/batch-service';
import { spoolBatchParts } from './batch-upload';

/**
 * BATCH-001 — one request, many files.
 *
 * Multipart text fields describe the batch (`name`, `projectId`, `documentType`); each file part is
 * one batch item. File bytes are spooled to bounded temporary storage before the document service
 * processes them one at a time. Partial success is the normal case, so the response is always 201
 * with per-item results.
 */

export function registerBatchRoutes(
  app: FastifyInstance,
  services: Services,
  guards: Guards,
): void {
  app.post('/batches', async (request, reply) => {
    const actor = await guards.authenticate(request);
    if (!request.isMultipart()) throw badRequest('Upload the files as multipart/form-data.');

    const tempDir = await mkdtemp(join(tmpdir(), 'idcp-batch-'));

    try {
      const { files, fields } = await spoolBatchParts(
        request.parts(),
        tempDir,
        services.config.MAX_REQUEST_MB * 1024 * 1024,
        services.config.MAX_REQUEST_MB,
      );
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

      // The service reads one buffer, uploads it, then advances the iterator. The temp files preserve
      // field/file ordering compatibility without retaining the entire batch in RAM.
      const batchFiles = async function* (): AsyncGenerator<BatchFile> {
        for (const file of files) {
          yield { buffer: await readFile(file.path), filename: file.filename };
        }
      };
      const batch = await services.batches.create(actor, { ...parsed.data, files: batchFiles() });
      return reply.code(201).send(batch);
    } finally {
      await rm(tempDir, { recursive: true, force: true }).catch(() => {
        request.log.error('could not remove temporary batch-upload files');
      });
    }
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
