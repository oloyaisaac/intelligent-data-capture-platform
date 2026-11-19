import type { Database } from '../db/database';

/** Queries for organisation-scoped dashboard aggregates. */
export class DashboardRepository {
  constructor(private readonly db: Database) {}

  documentsByStatus(organisationId: string): Promise<Array<{ status: string; count: number }>> {
    return this.db.query(
      'SELECT status, COUNT(*) AS count FROM documents WHERE organisation_id = ? AND deleted_at IS NULL GROUP BY status',
      [organisationId],
    );
  }

  documentsByType(
    organisationId: string,
  ): Promise<Array<{ document_type: string; count: number }>> {
    return this.db.query(
      `SELECT document_type, COUNT(*) AS count FROM documents
        WHERE organisation_id = ? AND deleted_at IS NULL
        GROUP BY document_type ORDER BY count DESC`,
      [organisationId],
    );
  }

  documentsByDay(
    organisationId: string,
    start: string,
  ): Promise<Array<{ day: string; status: string; count: number }>> {
    return this.db.query(
      `SELECT SUBSTR(created_at, 1, 10) AS day, status, COUNT(*) AS count FROM documents
        WHERE organisation_id = ? AND deleted_at IS NULL AND created_at >= ?
        GROUP BY SUBSTR(created_at, 1, 10), status ORDER BY day`,
      [organisationId, start],
    );
  }

  connectors(organisationId: string): Promise<{ total: number; active: number } | null> {
    return this.db.one(
      `SELECT COUNT(*) AS total,
              SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END) AS active
         FROM connectors WHERE organisation_id = ?`,
      [organisationId],
    );
  }

  exports(organisationId: string): Promise<{ total: number; ready: number } | null> {
    return this.db.one(
      `SELECT COUNT(*) AS total, SUM(CASE WHEN status = 'ready' THEN 1 ELSE 0 END) AS ready
         FROM exports WHERE organisation_id = ?`,
      [organisationId],
    );
  }

  reviewBacklog(organisationId: string): Promise<{ pending: number; approved: number } | null> {
    return this.db.one(
      `SELECT
         SUM(CASE WHEN status = 'needs_review' THEN 1 ELSE 0 END) AS pending,
         SUM(CASE WHEN status = 'approved' THEN 1 ELSE 0 END) AS approved
       FROM documents WHERE organisation_id = ? AND deleted_at IS NULL`,
      [organisationId],
    );
  }
}
