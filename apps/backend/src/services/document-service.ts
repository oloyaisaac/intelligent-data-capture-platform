import { createHash } from 'node:crypto';
import {
  AppError,
  LIMITS,
  badRequest,
  conflict,
  type DocumentStatus,
  type DocumentSummary,
  type DocumentType,
} from '@idcp/shared';
import type { Config } from '../config';
import { nowIso } from '../db/database';
import type { Logger } from '../logger';
import type {
  DocumentPagesRepository,
  DocumentsRepository,
  ExtractionsRepository,
} from '../repositories/document-repo';
import type { JobsRepository, AuditRepository } from '../repositories/system-repo';
import type { ReviewsRepository } from '../repositories/review-repo';
import type { OrganisationsRepository } from '../repositories/auth-repo';
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

export interface DocumentTransactionRepositories {
  organisations: Pick<OrganisationsRepository, 'lockRetentionPolicy'>;
  documents: Pick<
    DocumentsRepository,
    | 'createIfAbsent'
    | 'findByIdempotencyKey'
    | 'lockForReprocess'
    | 'queueForReprocess'
    | 'hasOtherStorageReference'
    | 'softDelete'
  >;
  pages: Pick<DocumentPagesRepository, 'create'>;
  reviews: Pick<ReviewsRepository, 'supersedeOpenForDocument'>;
  jobs: Pick<JobsRepository, 'enqueue' | 'latestExtractionForDocument' | 'hasActiveExtraction'>;
  audit: Pick<AuditRepository, 'record'>;
}

export interface DocumentServiceRepositories {
  documents: Pick<
    DocumentsRepository,
    | 'findById'
    | 'findByIdempotencyKey'
    | 'findExpiredForPurge'
    | 'hasAnyStorageReference'
    | 'list'
    | 'softDelete'
    | 'updateStatus'
  >;
  extractions: Pick<ExtractionsRepository, 'findLatestForDocument'>;
  jobs: Pick<JobsRepository, 'enqueue' | 'latestExtractionForDocument'>;
  audit: Pick<AuditRepository, 'record'>;
  transaction<T>(run: (repositories: DocumentTransactionRepositories) => Promise<T>): Promise<T>;
}

export class DocumentService {
  private readonly documents: DocumentServiceRepositories['documents'];
  private readonly extractions: DocumentServiceRepositories['extractions'];
  private readonly jobs: DocumentServiceRepositories['jobs'];
  private readonly audit: DocumentServiceRepositories['audit'];
  private readonly transaction: DocumentServiceRepositories['transaction'];

  constructor(
    repositories: DocumentServiceRepositories,
    private readonly config: Config,
    private readonly storage: Storage,
    private readonly hub: RealtimeHub,
    private readonly logger: Logger,
  ) {
    this.documents = repositories.documents;
    this.extractions = repositories.extractions;
    this.jobs = repositories.jobs;
    this.audit = repositories.audit;
    this.transaction = repositories.transaction;
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
      if (existing) return this.existingUpload(existing, this.jobs);
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

    let callbackFinished = false;
    let result: { document: DocumentSummary; jobId: string; duplicate: boolean };
    try {
      result = await this.transaction(async (repositories) => {
        const created = await repositories.documents.createIfAbsent({
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

        if (!created) {
          // A concurrent transaction won the key. Its document and job committed together.
          const existing = input.idempotencyKey
            ? await repositories.documents.findByIdempotencyKey(
                actor.organisationId,
                input.idempotencyKey,
              )
            : null;
          if (!existing) throw new Error('Conflicting upload could not be found.');
          const duplicate = await this.existingUpload(existing, repositories.jobs);
          callbackFinished = true;
          return duplicate;
        }

        await repositories.pages.create({
          documentId: created.id,
          pageNumber: 1,
          storageKey,
          width: null,
          height: null,
        });

        await repositories.audit.record({
          organisationId: actor.organisationId,
          actorType: actor.actorType,
          actorId: actor.userId,
          action: 'document.uploaded',
          targetType: 'document',
          targetId: created.id,
          metadata: { mimeType, sizeBytes: input.buffer.length, sha256 },
        });

        const job = await repositories.jobs.enqueue({
          organisationId: actor.organisationId,
          type: 'extract_document',
          documentId: created.id,
          payload: { documentTypeHint: input.documentType },
        });
        callbackFinished = true;
        return { document: toDocumentSummary(created), jobId: job.id, duplicate: false };
      });
    } catch (error) {
      // No COMMIT was attempted when the callback threw. A commit error is ambiguous, however,
      // so retain the file rather than risk deleting an object referenced by committed metadata.
      if (!callbackFinished) await this.removeUnreferencedUpload(storageKey);
      throw error;
    }

    if (result.duplicate) {
      await this.removeUnreferencedUpload(storageKey);
      return result;
    }
    this.hub.toOrganisation(actor.organisationId, 'document:queued', {
      documentId: result.document.id,
      jobId: result.jobId,
    });
    this.logger.info('document uploaded', {
      documentId: result.document.id,
      organisationId: actor.organisationId,
      bytes: input.buffer.length,
    });

    return result;
  }

  private async existingUpload(
    document: DocumentRow,
    jobs: Pick<JobsRepository, 'latestExtractionForDocument'>,
  ): Promise<{ document: DocumentSummary; jobId: string; duplicate: boolean }> {
    if (document.deleted_at) throw conflict('The previous upload has been deleted; use a new key.');
    const job = await jobs.latestExtractionForDocument(document.organisation_id, document.id);
    if (!job) {
      // Legacy rows created before atomic upload/job creation require explicit operator action.
      throw conflict('The previous upload has no extraction job. Reprocess it before retrying.');
    }
    return { document: toDocumentSummary(document), jobId: job.id, duplicate: true };
  }

  private async removeUnreferencedUpload(storageKey: string): Promise<void> {
    try {
      // A collision or legacy reference may make even an uncommitted upload key unsafe to remove.
      // This remains a point-in-time check; it does not fence other writers or undo overwrites.
      if (await this.documents.hasAnyStorageReference(storageKey)) {
        this.logger.warn('upload cleanup deferred for investigation');
        return;
      }
      await this.storage.delete(storageKey);
    } catch {
      // Fail closed on reference lookup or storage failure; operators may need reconciliation.
      this.logger.error('could not remove unreferenced upload file');
    }
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
    return this.transaction(async (repositories) => {
      // The document lock serialises concurrent repairs/reprocess requests. On PostgreSQL the
      // subsequent active-job query runs after the lock is acquired, using a fresh statement
      // snapshot; SQLite's immediate transaction serialises writers.
      const document = await repositories.documents.lockForReprocess(actor.organisationId, id);
      if (!document || document.deleted_at) throw new AppError('NOT_FOUND', 'Document not found.');
      if (await repositories.jobs.hasActiveExtraction(actor.organisationId, id)) {
        throw conflict('This document already has an extraction queued or in progress.');
      }
      // Preserve old review history but prevent decisions against a superseded extraction even
      // if the new extraction later fails and the old extraction remains the latest row.
      await repositories.reviews.supersedeOpenForDocument(actor.organisationId, id);
      await repositories.documents.queueForReprocess(actor.organisationId, id);
      const job = await repositories.jobs.enqueue({
        organisationId: actor.organisationId,
        type: 'extract_document',
        documentId: id,
      });
      await repositories.audit.record({
        organisationId: actor.organisationId,
        actorType: actor.actorType,
        actorId: actor.userId,
        action: 'document.reprocessed',
        targetType: 'document',
        targetId: id,
      });
      return { jobId: job.id };
    });
  }

  /** Soft delete hides the record. Existing soft-deleted files are not purged by retention. */
  async delete(actor: AuthenticatedActor, id: string): Promise<void> {
    await this.transaction(async (repositories) => {
      const ok = await repositories.documents.softDelete(actor.organisationId, id);
      if (!ok) throw new AppError('NOT_FOUND', 'Document not found.');
      await repositories.audit.record({
        organisationId: actor.organisationId,
        actorType: actor.actorType,
        actorId: actor.userId,
        action: 'document.deleted',
        targetType: 'document',
        targetId: id,
      });
    });
  }

  /**
   * Lock and recheck each expired document before removing its primary file, then soft-delete its
   * metadata and audit in the same database transaction. Storage remains outside DB atomicity.
   */
  async purgeExpired(organisationId: string, retentionDays: number): Promise<number> {
    if (retentionDays <= 0) return 0;
    const expired = await this.documents.findExpiredForPurge(organisationId, retentionDays);
    let purged = 0;
    let incomplete = false;
    for (const document of expired) {
      try {
        const outcome = await this.transaction(async (repositories) => {
          // Recheck the policy under an organisation lock before locking the document. This
          // serializes policy changes until the file and metadata operation finishes.
          const policy = await repositories.organisations.lockRetentionPolicy(organisationId);
          if (!policy || policy.retention_days !== retentionDays) return 'pending' as const;
          // Recheck the selected snapshot under the document lock before deleting any bytes.
          // Reprocessing and current-version extraction publication use the same document lock.
          const current = await repositories.documents.lockForReprocess(
            organisationId,
            document.id,
          );
          if (!current || current.deleted_at !== null) return 'skipped' as const;
          if (
            current.status === 'deleted' ||
            current.storage_key !== document.storage_key ||
            current.created_at !== document.created_at ||
            current.status !== document.status ||
            (await repositories.jobs.hasActiveExtraction(organisationId, document.id))
          )
            return 'pending' as const;
          // This reference check is still point-in-time, not a lock on other rows or object writes.
          if (
            await repositories.documents.hasOtherStorageReference(current.id, current.storage_key)
          )
            return 'pending' as const;
          await this.storage.delete(current.storage_key);
          // The storage deletion cannot participate in this transaction. A rollback can leave
          // active metadata without bytes; missing-file deletion must be idempotent for retry.
          const deleted = await repositories.documents.softDelete(organisationId, current.id);
          if (!deleted) throw new Error('Document changed during retention purge');
          await repositories.audit.record({
            organisationId,
            actorType: 'system',
            action: 'retention.purged',
            targetType: 'document',
            targetId: current.id,
            metadata: { count: 1, retentionDays, purgedAt: nowIso() },
          });
          return 'purged' as const;
        });
        if (outcome === 'purged') purged += 1;
        if (outcome === 'pending') incomplete = true;
      } catch {
        // Storage and database errors may contain paths or secrets. Keep failures retryable.
        incomplete = true;
      }
    }
    if (purged > 0) {
      this.logger.info('retention documents soft-deleted', { organisationId, count: purged });
    }
    if (incomplete)
      throw new Error('Retention purge incomplete; file deletion needs review or retry.');
    return purged;
  }
}
