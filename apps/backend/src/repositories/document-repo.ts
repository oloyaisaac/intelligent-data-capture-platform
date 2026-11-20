import type { DocumentStatus, DocumentType } from '@idcp/shared';
import { newId } from '@idcp/shared/ids';
import type { Database } from '../db/database';
import { nowIso, toDbBool } from '../db/database';
import type { DocumentPageRow, DocumentRow, ExtractionRow } from './types';
import { hasStorageReference } from './storage-references';

export class DocumentsRepository {
  constructor(private readonly db: Database) {}

  /** Insert unless another upload already claimed the organisation's idempotency key. */
  async createIfAbsent(input: {
    organisationId: string;
    uploadedBy?: string | null;
    deviceId?: string | null;
    idempotencyKey?: string | null;
    storageKey: string;
    mimeType: string;
    sizeBytes: number;
    sha256: string;
    pageCount?: number;
    documentType?: DocumentType;
    status?: DocumentStatus;
    projectId?: string | null;
  }): Promise<DocumentRow | null> {
    const now = nowIso();
    const row: DocumentRow = {
      id: newId(),
      organisation_id: input.organisationId,
      uploaded_by: input.uploadedBy ?? null,
      device_id: input.deviceId ?? null,
      idempotency_key: input.idempotencyKey ?? null,
      storage_key: input.storageKey,
      mime_type: input.mimeType,
      size_bytes: input.sizeBytes,
      sha256: input.sha256,
      page_count: input.pageCount ?? 1,
      document_type: input.documentType ?? 'unknown',
      status: input.status ?? 'uploaded',
      template_id: null,
      project_id: input.projectId ?? null,
      deleted_at: null,
      created_at: now,
      updated_at: now,
    };
    const inserted = await this.db.one<{ id: string }>(
      `INSERT INTO documents (id, organisation_id, uploaded_by, device_id, idempotency_key, storage_key,
        mime_type, size_bytes, sha256, page_count, document_type, status, project_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (organisation_id, idempotency_key) DO NOTHING RETURNING id`,
      [
        row.id,
        row.organisation_id,
        row.uploaded_by,
        row.device_id,
        row.idempotency_key,
        row.storage_key,
        row.mime_type,
        row.size_bytes,
        row.sha256,
        row.page_count,
        row.document_type,
        row.status,
        row.project_id,
        row.created_at,
        row.updated_at,
      ],
    );
    return inserted ? row : null;
  }

  findById(organisationId: string, id: string): Promise<DocumentRow | null> {
    return this.db.one<DocumentRow>(
      'SELECT * FROM documents WHERE organisation_id = ? AND id = ?',
      [organisationId, id],
    );
  }

  findByIdempotencyKey(organisationId: string, key: string): Promise<DocumentRow | null> {
    return this.db.one<DocumentRow>(
      'SELECT * FROM documents WHERE organisation_id = ? AND idempotency_key = ?',
      [organisationId, key],
    );
  }

  async list(
    organisationId: string,
    filters: {
      status?: DocumentStatus;
      documentType?: DocumentType;
      deviceId?: string;
      projectId?: string;
      includeDeleted?: boolean;
      limit?: number;
      cursor?: string;
    } = {},
  ): Promise<DocumentRow[]> {
    const clauses = ['organisation_id = ?'];
    const params: unknown[] = [organisationId];
    if (!filters.includeDeleted) clauses.push('deleted_at IS NULL');
    if (filters.status) {
      clauses.push('status = ?');
      params.push(filters.status);
    }
    if (filters.documentType) {
      clauses.push('document_type = ?');
      params.push(filters.documentType);
    }
    if (filters.deviceId) {
      clauses.push('device_id = ?');
      params.push(filters.deviceId);
    }
    if (filters.projectId) {
      clauses.push('project_id = ?');
      params.push(filters.projectId);
    }
    if (filters.cursor) {
      clauses.push('created_at < ?');
      params.push(filters.cursor);
    }
    params.push(Math.min(filters.limit ?? 25, 100));
    return this.db.query<DocumentRow>(
      `SELECT * FROM documents WHERE ${clauses.join(' AND ')} ORDER BY created_at DESC, id DESC LIMIT ?`,
      params,
    );
  }

  async updateStatus(
    id: string,
    status: DocumentStatus,
    documentType?: DocumentType,
  ): Promise<void> {
    if (documentType) {
      await this.db.execute(
        'UPDATE documents SET status = ?, document_type = ?, updated_at = ? WHERE id = ?',
        [status, documentType, nowIso(), id],
      );
      return;
    }
    await this.db.execute('UPDATE documents SET status = ?, updated_at = ? WHERE id = ?', [
      status,
      nowIso(),
      id,
    ]);
  }

  /** Lock the document before checking active jobs, only inside a transaction. */
  lockForReprocess(organisationId: string, id: string): Promise<DocumentRow | null> {
    const lock = this.db.driver === 'postgres' ? ' FOR UPDATE' : '';
    return this.db.one<DocumentRow>(
      `SELECT * FROM documents WHERE organisation_id = ? AND id = ?${lock}`,
      [organisationId, id],
    );
  }

  /** Only call after locking the document and checking for active jobs in the same transaction. */
  async queueForReprocess(organisationId: string, id: string): Promise<void> {
    await this.db.execute(
      `UPDATE documents SET status = 'queued', updated_at = ?
       WHERE organisation_id = ? AND id = ? AND deleted_at IS NULL`,
      [nowIso(), organisationId, id],
    );
  }

  /** Call with a locked running job inside a transaction; never revive a deleted or reviewed row. */
  beginProcessing(organisationId: string, id: string): Promise<DocumentRow | null> {
    return this.db.one<DocumentRow>(
      `UPDATE documents SET status = 'processing', updated_at = ?
       WHERE organisation_id = ? AND id = ? AND deleted_at IS NULL
         AND status IN ('queued', 'processing') RETURNING *`,
      [nowIso(), organisationId, id],
    );
  }

  /** Publish only while the document is still in processing; the transaction holds the row lock. */
  async finishProcessing(
    organisationId: string,
    id: string,
    status: 'needs_review' | 'extracted',
    documentType: DocumentType,
  ): Promise<boolean> {
    const row = await this.db.one<{ id: string }>(
      `UPDATE documents SET status = ?, document_type = ?, updated_at = ?
       WHERE organisation_id = ? AND id = ? AND deleted_at IS NULL AND status = 'processing'
       RETURNING id`,
      [status, documentType, nowIso(), organisationId, id],
    );
    return row !== null;
  }

  /** Called in the job-failure transaction; do not overwrite deleted or reviewed documents. */
  async failProcessing(organisationId: string, id: string): Promise<boolean> {
    const row = await this.db.one<{ id: string }>(
      `UPDATE documents SET status = 'failed', updated_at = ?
       WHERE organisation_id = ? AND id = ? AND deleted_at IS NULL AND status = 'processing'
       RETURNING id`,
      [nowIso(), organisationId, id],
    );
    return row !== null;
  }

  /** Records a reviewer-confirmed classification without touching the lifecycle status. */
  async updateAnyDocumentType(id: string, documentType: DocumentType): Promise<void> {
    await this.db.execute('UPDATE documents SET document_type = ?, updated_at = ? WHERE id = ?', [
      documentType,
      nowIso(),
      id,
    ]);
  }

  async softDelete(organisationId: string, id: string): Promise<boolean> {
    const now = nowIso();
    const updated = await this.db.one<{ id: string }>(
      `UPDATE documents SET status = 'deleted', deleted_at = ?, updated_at = ?
       WHERE organisation_id = ? AND id = ? AND deleted_at IS NULL RETURNING id`,
      [now, now, organisationId, id],
    );
    return updated !== null;
  }

  /** Fail closed on known references other than this document and its pages. */
  hasOtherStorageReference(documentId: string, key: string): Promise<boolean> {
    return hasStorageReference(this.db, key, { documentId });
  }

  /** Documents past the organisation's retention window (SEC-001). */
  async findExpiredForPurge(organisationId: string, retentionDays: number): Promise<DocumentRow[]> {
    const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000).toISOString();
    return this.db.query<DocumentRow>(
      `SELECT * FROM documents
        WHERE organisation_id = ? AND deleted_at IS NULL AND created_at < ?`,
      [organisationId, cutoff],
    );
  }

  async listApproved(
    organisationId: string,
    filters: { documentType?: DocumentType; from?: string; to?: string; limit?: number } = {},
  ): Promise<DocumentRow[]> {
    const clauses = ["organisation_id = ? AND status = 'approved' AND deleted_at IS NULL"];
    const params: unknown[] = [organisationId];
    if (filters.documentType) {
      clauses.push('document_type = ?');
      params.push(filters.documentType);
    }
    if (filters.from) {
      clauses.push('created_at >= ?');
      params.push(filters.from);
    }
    if (filters.to) {
      clauses.push('created_at <= ?');
      params.push(filters.to);
    }
    params.push(Math.min(filters.limit ?? 5000, 10_000));
    return this.db.query<DocumentRow>(
      `SELECT * FROM documents WHERE ${clauses.join(' AND ')} ORDER BY created_at DESC LIMIT ?`,
      params,
    );
  }
}

export class DocumentPagesRepository {
  constructor(private readonly db: Database) {}

  async create(input: {
    documentId: string;
    pageNumber: number;
    storageKey: string;
    ocrText?: string | null;
    ocrWords?: unknown[];
    width?: number | null;
    height?: number | null;
  }): Promise<DocumentPageRow> {
    const row: DocumentPageRow = {
      id: newId(),
      document_id: input.documentId,
      page_number: input.pageNumber,
      storage_key: input.storageKey,
      width: input.width ?? null,
      height: input.height ?? null,
      ocr_text: input.ocrText ?? null,
      ocr_words: JSON.stringify(input.ocrWords ?? []),
      created_at: nowIso(),
    };
    await this.db.execute(
      `INSERT INTO document_pages (id, document_id, page_number, storage_key, width, height, ocr_text, ocr_words, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        row.id,
        row.document_id,
        row.page_number,
        row.storage_key,
        row.width,
        row.height,
        row.ocr_text,
        row.ocr_words,
        row.created_at,
      ],
    );
    return row;
  }

  listForDocument(documentId: string): Promise<DocumentPageRow[]> {
    return this.db.query<DocumentPageRow>(
      'SELECT * FROM document_pages WHERE document_id = ? ORDER BY page_number',
      [documentId],
    );
  }

  async upsertOcr(
    documentId: string,
    pageNumber: number,
    text: string,
    words: unknown[],
  ): Promise<void> {
    const existing = await this.db.one<DocumentPageRow>(
      'SELECT * FROM document_pages WHERE document_id = ? AND page_number = ?',
      [documentId, pageNumber],
    );
    if (!existing) return;
    await this.db.execute(
      'UPDATE document_pages SET ocr_text = ?, ocr_words = ? WHERE document_id = ? AND page_number = ?',
      [text, JSON.stringify(words), documentId, pageNumber],
    );
  }
}

export class ExtractionsRepository {
  constructor(private readonly db: Database) {}

  async create(input: {
    documentId: string;
    organisationId: string;
    udm: unknown;
    udmVersion: string;
    provider: string;
    confidence: number;
    needsReview: boolean;
    modelVersion?: string | null;
    latencyMs?: number | null;
    costMicros?: number;
  }): Promise<ExtractionRow> {
    const previous = await this.db.one<{ attempt: number }>(
      'SELECT MAX(attempt) AS attempt FROM extractions WHERE document_id = ?',
      [input.documentId],
    );
    const row: ExtractionRow = {
      id: newId(),
      document_id: input.documentId,
      organisation_id: input.organisationId,
      attempt: Number(previous?.attempt ?? 0) + 1,
      udm: JSON.stringify(input.udm),
      udm_version: input.udmVersion,
      provider: input.provider,
      model_version: input.modelVersion ?? null,
      confidence: input.confidence,
      needs_review: toDbBool(input.needsReview),
      latency_ms: input.latencyMs ?? null,
      cost_micros: input.costMicros ?? 0,
      created_at: nowIso(),
    };
    await this.db.execute(
      `INSERT INTO extractions (id, document_id, organisation_id, attempt, udm, udm_version, provider,
        model_version, confidence, needs_review, latency_ms, cost_micros, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        row.id,
        row.document_id,
        row.organisation_id,
        row.attempt,
        row.udm,
        row.udm_version,
        row.provider,
        row.model_version,
        row.confidence,
        row.needs_review,
        row.latency_ms,
        row.cost_micros,
        row.created_at,
      ],
    );
    return row;
  }

  findLatestForDocument(documentId: string): Promise<ExtractionRow | null> {
    return this.db.one<ExtractionRow>(
      'SELECT * FROM extractions WHERE document_id = ? ORDER BY attempt DESC LIMIT 1',
      [documentId],
    );
  }

  findById(organisationId: string, id: string): Promise<ExtractionRow | null> {
    return this.db.one<ExtractionRow>(
      'SELECT * FROM extractions WHERE organisation_id = ? AND id = ?',
      [organisationId, id],
    );
  }

  async replaceFields(
    extractionId: string,
    fields: Array<{
      fieldPath: string;
      fieldLabel?: string | null;
      value: unknown;
      valueNormalised?: string | null;
      confidence: number;
      needsReview: boolean;
      bbox?: unknown;
      pageNumber?: number | null;
    }>,
  ): Promise<void> {
    await this.db.execute('DELETE FROM extraction_fields WHERE extraction_id = ?', [extractionId]);
    for (const field of fields) {
      await this.db.execute(
        `INSERT INTO extraction_fields (id, extraction_id, field_path, field_label, value_text,
          value_normalised, confidence, bbox, page_number, needs_review, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          newId(),
          extractionId,
          field.fieldPath,
          field.fieldLabel ?? null,
          field.value === null || field.value === undefined ? null : String(field.value),
          field.valueNormalised ?? null,
          field.confidence,
          field.bbox ? JSON.stringify(field.bbox) : null,
          field.pageNumber ?? null,
          toDbBool(field.needsReview),
          nowIso(),
        ],
      );
    }
  }

  listFieldsNeedingReview(
    extractionId: string,
  ): Promise<Array<{ field_path: string; confidence: number }>> {
    return this.db.query<{ field_path: string; confidence: number }>(
      'SELECT field_path, confidence FROM extraction_fields WHERE extraction_id = ? AND needs_review = 1 ORDER BY confidence',
      [extractionId],
    );
  }
}
