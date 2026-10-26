import { createHash } from 'node:crypto';
import {
  AppError,
  LIMITS,
  badRequest,
  type DocumentStatus,
  type DocumentSummary,
  type DocumentType,
} from '@idcp/shared';
import type { Config } from '../config';
import type { Database } from '../db/database';
import { nowIso } from '../db/database';
import type { Logger } from '../logger';
import {
  DocumentPagesRepository,
  DocumentsRepository,
  ExtractionsRepository,
} from '../repositories/document-repo';
import { JobsRepository, AuditRepository } from '../repositories/system-repo';
import type { DocumentRow } from '../repositories/types';
import { buildStorageKey, extensionForMimeType, sniffMimeType, type Storage } from '../storage';
import type { AuthenticatedActor } from './auth-service';
import type { RealtimeHub } from '../realtime/hub';

export function toDocumentSummary(row: DocumentRow): DocumentSummary {
  return {
    id: row.id,
    status: row.status,
    documentType: row.document_type,
    mimeType: row.mime_type,
    sizeBytes: row.size_bytes,
    pageCount: row.page_count,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    deletedAt: row.deleted_at,
  };
}

export interface UploadInput {
  buffer: Buffer;
  filename?: string;
  idempotencyKey?: string;
  documentType?: DocumentType;
  projectId?: string | null;
}

export class DocumentService {
  private readonly documents: DocumentsRepository;
  private readonly extractions: ExtractionsRepository;
  private readonly jobs: JobsRepository;
  private readonly audit: AuditRepository;

  constructor(
    private readonly db: Database,
    private readonly config: Config,
    private readonly storage: Storage,
    private readonly hub: RealtimeHub,
    private readonly logger: Logger,
  ) {
    this.documents = new DocumentsRepository(db);
    this.extractions = new ExtractionsRepository(db);
    this.jobs = new JobsRepository(db);
    this.audit = new AuditRepository(db);
  }

  /**
   * DOC-001: validate (sniffed content, not the header), store, record, enqueue.
   * Idempotent per organisation + client key so a retried upload never creates a second document.
   */
  async upload(
    actor: AuthenticatedActor,
    input: UploadInput,
  ): Promise<{ document: DocumentSummary; jobId: string; duplicate: boolean }> {
    if (!input.buffer || input.buffer.length === 0) throw badRequest('The uploaded file is empty.');

    const maxBytes = this.config.MAX_UPLOAD_MB * 1024 * 1024;
    if (input.buffer.length > maxBytes) {
      throw new AppError(
        'PAYLOAD_TOO_LARGE',
        `That file is ${(input.buffer.length / 1024 / 1024).toFixed(1)} MB. The limit is ${this.config.MAX_UPLOAD_MB} MB.`,
      );
    }

    const mimeType = sniffMimeType(input.buffer);
    if (!mimeType || !(LIMITS.allowedUploadMimeTypes as readonly string[]).includes(mimeType)) {
      throw new AppError(
        'UNSUPPORTED_MEDIA_TYPE',
        'That file type is not supported. Upload a JPEG, PNG, HEIC image or a PDF.',
      );
    }

    if (input.idempotencyKey) {
      const existing = await this.documents.findByIdempotencyKey(
        actor.organisationId,
        input.idempotencyKey,
      );
      if (existing) {
        const job = await this.jobs.enqueue({
          organisationId: actor.organisationId,
          type: 'extract_document',
          documentId: existing.id,
        });
        return { document: toDocumentSummary(existing), jobId: job.id, duplicate: true };
      }
    }

    const sha256 = createHash('sha256').update(input.buffer).digest('hex');
    const documentId = crypto.randomUUID();
    const storageKey = buildStorageKey({
      organisationId: actor.organisationId,
      kind: 'documents',
      id: documentId,
      extension: extensionForMimeType(mimeType),
    });

    await this.storage.put(storageKey, input.buffer, mimeType);

    const document = await this.db.transaction(async (tx) => {
      const documents = new DocumentsRepository(tx);
      const created = await documents.create({
        organisationId: actor.organisationId,
        uploadedBy: actor.userId,
        deviceId: actor.deviceId ?? null,
        idempotencyKey: input.idempotencyKey ?? null,
        storageKey,
        mimeType,
        sizeBytes: input.buffer.length,
        sha256,
        documentType: input.documentType ?? 'unknown',
        status: 'queued',
        projectId: input.projectId ?? null,
      });

      await new DocumentPagesRepository(tx).create({
        documentId: created.id,
        pageNumber: 1,
        storageKey,
        width: null,
        height: null,
      });

      await new AuditRepository(tx).record({
        organisationId: actor.organisationId,
        actorType: actor.actorType,
        actorId: actor.userId,
        action: 'document.uploaded',
        targetType: 'document',
        targetId: created.id,
        metadata: { mimeType, sizeBytes: input.buffer.length, sha256 },
      });

      return created;
    });

    const job = await this.jobs.enqueue({
      organisationId: actor.organisationId,
      type: 'extract_document',
      documentId: document.id,
      payload: { documentTypeHint: input.documentType },
    });

    this.hub.toOrganisation(actor.organisationId, 'document:queued', {
      documentId: document.id,
      jobId: job.id,
    });
    this.logger.info('document uploaded', {
      documentId: document.id,
      organisationId: actor.organisationId,
      bytes: input.buffer.length,
    });

    return { document: toDocumentSummary(document), jobId: job.id, duplicate: false };
  }

  async list(
    actor: AuthenticatedActor,
    filters: {
      status?: DocumentStatus;
      documentType?: DocumentType;
      deviceId?: string;
      projectId?: string;
      limit?: number;
      cursor?: string;
    },
  ): Promise<{ items: DocumentSummary[]; nextCursor: string | null }> {
    const rows = await this.documents.list(actor.organisationId, filters);
    const items = rows.map(toDocumentSummary);
    const nextCursor =
      items.length === (filters.limit ?? LIMITS.defaultPageSize)
        ? (items.at(-1)?.createdAt ?? null)
        : null;
    return { items, nextCursor };
  }

  async get(actor: AuthenticatedActor, id: string): Promise<DocumentSummary> {
    const row = await this.documents.findById(actor.organisationId, id);
    if (!row || row.deleted_at) throw new AppError('NOT_FOUND', 'Document not found.');
    await this.audit.record({
      organisationId: actor.organisationId,
      actorType: actor.actorType,
      actorId: actor.userId,
      action: 'document.viewed',
      targetType: 'document',
      targetId: id,
    });
    return toDocumentSummary(row);
  }

  async getFile(
    actor: AuthenticatedActor,
    id: string,
  ): Promise<{ buffer: Buffer; mimeType: string }> {
    const row = await this.documents.findById(actor.organisationId, id);
    if (!row || row.deleted_at) throw new AppError('NOT_FOUND', 'Document not found.');
    const buffer = await this.storage.get(row.storage_key);
    return { buffer, mimeType: row.mime_type };
  }

  /** Current extraction: the UDM plus its flattened fields for the review UI. */
  async getResult(actor: AuthenticatedActor, id: string) {
    const document = await this.documents.findById(actor.organisationId, id);
    if (!document || document.deleted_at) throw new AppError('NOT_FOUND', 'Document not found.');

    const extraction = await this.extractions.findLatestForDocument(id);
    if (!extraction) {
      return { document: toDocumentSummary(document), extraction: null };
    }
    return {
      document: toDocumentSummary(document),
      extraction: {
        id: extraction.id,
        attempt: extraction.attempt,
        udmVersion: extraction.udm_version,
        provider: extraction.provider,
        confidence: extraction.confidence,
        needsReview: extraction.needs_review === 1,
        udm: JSON.parse(extraction.udm) as unknown,
        createdAt: extraction.created_at,
      },
    };
  }

  async reprocess(actor: AuthenticatedActor, id: string): Promise<{ jobId: string }> {
    const document = await this.documents.findById(actor.organisationId, id);
    if (!document || document.deleted_at) throw new AppError('NOT_FOUND', 'Document not found.');

    await this.documents.updateStatus(id, 'queued');
    const job = await this.jobs.enqueue({
      organisationId: actor.organisationId,
      type: 'extract_document',
      documentId: id,
    });
    await this.audit.record({
      organisationId: actor.organisationId,
      actorType: actor.actorType,
      actorId: actor.userId,
      action: 'document.reprocessed',
      targetType: 'document',
      targetId: id,
    });
    return { jobId: job.id };
  }

  /** Soft delete: the record disappears from the app; the purge job removes the bytes. */
  async delete(actor: AuthenticatedActor, id: string): Promise<void> {
    const ok = await this.documents.softDelete(actor.organisationId, id);
    if (!ok) throw new AppError('NOT_FOUND', 'Document not found.');
    await this.audit.record({
      organisationId: actor.organisationId,
      actorType: actor.actorType,
      actorId: actor.userId,
      action: 'document.deleted',
      targetType: 'document',
      targetId: id,
    });
  }

  /**
   * SEC-001 retention purge: removes storage objects and rows, and audits what it did.
   * Returns the number of documents purged.
   */
  async purgeExpired(organisationId: string, retentionDays: number): Promise<number> {
    if (retentionDays <= 0) return 0;
    const expired = await this.documents.findExpiredForPurge(organisationId, retentionDays);
    for (const document of expired) {
      await this.storage.delete(document.storage_key).catch(() => undefined);
      await this.documents.softDelete(organisationId, document.id);
    }
    if (expired.length > 0) {
      await this.audit.record({
        organisationId,
        actorType: 'system',
        action: 'retention.purged',
        metadata: { count: expired.length, retentionDays, purgedAt: nowIso() },
      });
      this.logger.info('retention purge complete', { organisationId, count: expired.length });
    }
    return expired.length;
  }
}
