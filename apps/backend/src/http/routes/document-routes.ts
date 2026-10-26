import type { FastifyInstance } from 'fastify';
import {
  badRequest,
  DOCUMENT_STATUSES,
  DOCUMENT_TYPES,
  type DocumentStatus,
  type DocumentType,
} from '@idcp/shared';
import type { Services } from '../../services/container';
import type { Guards } from '../guards';

const MAX_LIST = 100;
const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9_-]{8,100}$/;

/** An unexpected key shape is ignored rather than rejecting an otherwise valid upload. */
function sanitiseIdempotencyKey(value: string | undefined): string | undefined {
  if (!value) return undefined;
  return IDEMPOTENCY_KEY_PATTERN.test(value) ? value : undefined;
}

export function registerDocumentRoutes(
  app: FastifyInstance,
  services: Services,
  guards: Guards,
): void {
  /** DOC-001 — upload one document (image or PDF). */
  app.post('/documents', async (request, reply) => {
    const actor = await guards.authenticate(request);

    if (!request.isMultipart()) {
      throw badRequest('Upload the file as multipart/form-data.');
    }

    const file = await request.file({
      limits: { fileSize: services.config.MAX_UPLOAD_MB * 1024 * 1024, files: 1 },
    });
    if (!file) throw badRequest('No file was uploaded.');

    const buffer = await file.toBuffer();
    const fields = file.fields as Record<string, { value?: unknown } | undefined>;
    // Accept the key as a header (preferred) or as a form field (browser FormData).
    const idempotencyKeyHeader = request.headers['idempotency-key'];
    const idempotencyKeyField = fields.idempotencyKey?.value;
    const idempotencyKey = sanitiseIdempotencyKey(
      typeof idempotencyKeyHeader === 'string'
        ? idempotencyKeyHeader
        : typeof idempotencyKeyField === 'string'
          ? idempotencyKeyField
          : undefined,
    );

    const documentTypeRaw = fields.documentType?.value;
    const documentType =
      typeof documentTypeRaw === 'string' &&
      (DOCUMENT_TYPES as readonly string[]).includes(documentTypeRaw)
        ? (documentTypeRaw as DocumentType)
        : undefined;

    const result = await services.documents.upload(actor, {
      buffer,
      filename: file.filename,
      idempotencyKey,
      documentType,
    });

    return reply.code(result.duplicate ? 200 : 201).send({
      id: result.document.id,
      status: result.document.status,
      jobId: result.jobId,
      document: result.document,
      duplicate: result.duplicate,
    });
  });

  app.get('/documents', async (request) => {
    const actor = await guards.authenticate(request);
    const query = request.query as Record<string, string | undefined>;
    const status =
      query.status && (DOCUMENT_STATUSES as readonly string[]).includes(query.status)
        ? (query.status as DocumentStatus)
        : undefined;
    const documentType =
      query.type && (DOCUMENT_TYPES as readonly string[]).includes(query.type)
        ? (query.type as DocumentType)
        : undefined;

    return services.documents.list(actor, {
      status,
      documentType,
      deviceId: query.deviceId,
      limit: Math.min(Number(query.limit ?? 25) || 25, MAX_LIST),
      cursor: query.cursor,
    });
  });

  app.get('/documents/:id', async (request) => {
    const actor = await guards.authenticate(request);
    return services.documents.get(actor, guards.uuidParam(request));
  });

  app.get('/documents/:id/file', async (request, reply) => {
    const actor = await guards.authenticate(request);
    const { buffer, mimeType } = await services.documents.getFile(actor, guards.uuidParam(request));
    reply.header('content-type', mimeType);
    reply.header('cache-control', 'private, no-store');
    reply.header('x-content-type-options', 'nosniff');
    return reply.send(buffer);
  });

  app.get('/documents/:id/result', async (request) => {
    const actor = await guards.authenticate(request);
    return services.documents.getResult(actor, guards.uuidParam(request));
  });

  app.post('/documents/:id/reprocess', async (request, reply) => {
    const actor = await guards.authenticate(request);
    const result = await services.documents.reprocess(actor, guards.uuidParam(request));
    return reply.code(202).send(result);
  });

  app.delete('/documents/:id', async (request, reply) => {
    const actor = await guards.authenticate(request);
    await services.documents.delete(actor, guards.uuidParam(request));
    return reply.code(204).send();
  });
}
