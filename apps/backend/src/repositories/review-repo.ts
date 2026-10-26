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

  async findApprovedUdm(documentId: string): Promise<unknown | null> {
    const row = await this.db.one<ReviewRow>(
      "SELECT * FROM reviews WHERE document_id = ? AND status = 'approved' ORDER BY completed_at DESC LIMIT 1",
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
      changed_by: input.changedBy,
      created_at: nowIso(),
    };
    await this.db.execute(
      `INSERT INTO review_changes (id, review_id, field_path, original_value, corrected_value,
        original_confidence, changed_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        row.id,
        row.review_id,
        row.field_path,
        row.original_value,
        row.corrected_value,
        row.original_confidence,
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
  ): Promise<Array<{ field_path: string; corrections: number; average_confidence: number }>> {
    return this.db.query(
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
  }
}
