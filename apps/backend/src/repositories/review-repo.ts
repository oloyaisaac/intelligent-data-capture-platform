import { newId } from '@idcp/shared/ids';
import type { Database } from '../db/database';
import { nowIso } from '../db/database';
import type { ReviewChangeRow, ReviewRow } from './types';

export class ReviewsRepository {
  constructor(private readonly db: Database) {}

  async openOrResume(input: {
    organisationId: string;
    documentId: string;
    extractionId: string;
    reviewerId: string;
  }): Promise<ReviewRow> {
    const existing = await this.db.one<ReviewRow>(
      `SELECT * FROM reviews WHERE document_id = ? AND extraction_id = ? AND status = 'in_progress'`,
      [input.documentId, input.extractionId],
    );
    if (existing) return existing;

    const row: ReviewRow = {
      id: newId(),
      organisation_id: input.organisationId,
      document_id: input.documentId,
      extraction_id: input.extractionId,
      reviewer_id: input.reviewerId,
      status: 'in_progress',
      approved_udm: null,
      notes: null,
      completed_at: null,
      created_at: nowIso(),
      updated_at: nowIso(),
    };
    await this.db.execute(
      `INSERT INTO reviews (id, organisation_id, document_id, extraction_id, reviewer_id, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        row.id,
        row.organisation_id,
        row.document_id,
        row.extraction_id,
        row.reviewer_id,
        row.status,
        row.created_at,
        row.updated_at,
      ],
    );
    return row;
  }

  findById(organisationId: string, id: string): Promise<ReviewRow | null> {
    return this.db.one<ReviewRow>('SELECT * FROM reviews WHERE organisation_id = ? AND id = ?', [
      organisationId,
      id,
    ]);
  }

  setExtraction(id: string, extractionId: string, updatedAt: string): Promise<void> {
    return this.db.execute('UPDATE reviews SET extraction_id = ?, updated_at = ? WHERE id = ?', [
      extractionId,
      updatedAt,
      id,
    ]);
  }

  /** Call while holding the document lock in the reprocess transaction. */
  async supersedeOpenForDocument(organisationId: string, documentId: string): Promise<void> {
    const now = nowIso();
    await this.db.execute(
      `UPDATE reviews SET status = 'superseded', completed_at = ?, updated_at = ?
       WHERE organisation_id = ? AND document_id = ? AND status = 'in_progress'`,
      [now, now, organisationId, documentId],
    );
  }

  findOpenForDocument(documentId: string): Promise<ReviewRow | null> {
    return this.db.one<ReviewRow>(
      "SELECT * FROM reviews WHERE document_id = ? AND status = 'in_progress' ORDER BY created_at DESC LIMIT 1",
      [documentId],
    );
  }

  async complete(
    id: string,
    input: { status: 'approved' | 'rejected'; approvedUdm?: unknown; notes?: string | null },
  ): Promise<void> {
    await this.db.execute(
      `UPDATE reviews SET status = ?, approved_udm = ?, notes = ?, completed_at = ?, updated_at = ? WHERE id = ?`,
      [
        input.status,
        input.approvedUdm === undefined ? null : JSON.stringify(input.approvedUdm),
        input.notes ?? null,
        nowIso(),
        nowIso(),
        id,
      ],
    );
  }

  /** Return only an approval of the latest extraction of a currently approved, idle document. */
  async findApprovedUdm(documentId: string): Promise<unknown | null> {
    const row = await this.db.one<ReviewRow>(
      `SELECT r.* FROM reviews r
       JOIN documents d ON d.id = r.document_id AND d.organisation_id = r.organisation_id
       WHERE r.document_id = ? AND r.status = 'approved'
         AND d.status = 'approved' AND d.deleted_at IS NULL
         AND r.extraction_id = (
           SELECT e.id FROM extractions e WHERE e.document_id = d.id
             AND e.organisation_id = d.organisation_id ORDER BY e.attempt DESC LIMIT 1
         )
         AND NOT EXISTS (
           SELECT 1 FROM jobs j WHERE j.document_id = d.id AND j.organisation_id = d.organisation_id
             AND j.type = 'extract_document' AND j.status IN ('queued', 'running')
         )
       ORDER BY r.completed_at DESC, r.id DESC LIMIT 1`,
      [documentId],
    );
    if (!row?.approved_udm) return null;
    try {
      return JSON.parse(row.approved_udm) as unknown;
    } catch {
      return null;
    }
  }
}

export class ReviewChangesRepository {
  constructor(private readonly db: Database) {}

  async create(input: {
    reviewId: string;
    fieldPath: string;
    originalValue: unknown;
    correctedValue: unknown;
    originalConfidence?: number | null;
    changedBy: string;
    /** REV-002: recorded with the correction so statistics can be grouped by document type. */
    documentType?: string | null;
  }): Promise<ReviewChangeRow> {
    const row: ReviewChangeRow = {
      id: newId(),
      review_id: input.reviewId,
      field_path: input.fieldPath,
      original_value:
        input.originalValue === null || input.originalValue === undefined
          ? null
          : String(input.originalValue),
      corrected_value:
        input.correctedValue === null || input.correctedValue === undefined
          ? null
          : String(input.correctedValue),
      original_confidence: input.originalConfidence ?? null,
      document_type: input.documentType ?? null,
      changed_by: input.changedBy,
      created_at: nowIso(),
    };
    await this.db.execute(
      `INSERT INTO review_changes (id, review_id, field_path, original_value, corrected_value,
        original_confidence, document_type, changed_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        row.id,
        row.review_id,
        row.field_path,
        row.original_value,
        row.corrected_value,
        row.original_confidence,
        row.document_type,
        row.changed_by,
        row.created_at,
      ],
    );
    return row;
  }

  listForReview(reviewId: string): Promise<ReviewChangeRow[]> {
    return this.db.query<ReviewChangeRow>(
      'SELECT * FROM review_changes WHERE review_id = ? ORDER BY created_at',
      [reviewId],
    );
  }

  /** Correction statistics used by the learning loop (REV-002). */
  async statisticsForOrganisation(
    organisationId: string,
  ): Promise<
    Array<{ field_path: string; corrections: number; average_confidence: number | null }>
  > {
    const rows = await this.db.query<{
      field_path: string;
      corrections: number | string;
      average_confidence: number | string | null;
    }>(
      `SELECT rc.field_path,
              COUNT(*) AS corrections,
              AVG(rc.original_confidence) AS average_confidence
         FROM review_changes rc
         JOIN reviews r ON r.id = rc.review_id
        WHERE r.organisation_id = ?
        GROUP BY rc.field_path
        ORDER BY corrections DESC`,
      [organisationId],
    );
    return rows.map((row) => ({
      field_path: row.field_path,
      corrections: Number(row.corrections),
      average_confidence: row.average_confidence === null ? null : Number(row.average_confidence),
    }));
  }

  /** The same statistics split by document type, which is how extraction rules are scoped. */
  async statisticsByDocumentType(
    organisationId: string,
  ): Promise<
    Array<{ document_type: string | null; corrections: number; average_confidence: number | null }>
  > {
    const rows = await this.db.query<{
      document_type: string | null;
      corrections: number | string;
      average_confidence: number | string | null;
    }>(
      `SELECT rc.document_type,
              COUNT(*) AS corrections,
              AVG(rc.original_confidence) AS average_confidence
         FROM review_changes rc
         JOIN reviews r ON r.id = rc.review_id
        WHERE r.organisation_id = ?
        GROUP BY rc.document_type
        ORDER BY corrections DESC`,
      [organisationId],
    );
    return rows.map((row) => ({
      document_type: row.document_type,
      corrections: Number(row.corrections),
      average_confidence: row.average_confidence === null ? null : Number(row.average_confidence),
    }));
  }

  /**
   * The training hand-off (REV-002). Only ever called when the organisation has opted in;
   * the caller enforces that, because a query cannot know the policy.
   */
  async listForTraining(
    organisationId: string,
    limit = 500,
  ): Promise<
    Array<{
      document_type: string | null;
      field_path: string;
      original_value: string | null;
      corrected_value: string | null;
      original_confidence: number | null;
      created_at: string;
    }>
  > {
    return this.db.query(
      `SELECT rc.document_type, rc.field_path, rc.original_value, rc.corrected_value,
              rc.original_confidence, rc.created_at
         FROM review_changes rc
         JOIN reviews r ON r.id = rc.review_id
        WHERE r.organisation_id = ?
        ORDER BY rc.created_at DESC
        LIMIT ?`,
      [organisationId, limit],
    );
  }
}
