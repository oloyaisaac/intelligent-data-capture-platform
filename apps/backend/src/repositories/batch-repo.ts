import { newId } from '@idcp/shared/ids';
import type { Database } from '../db/database';
import { nowIso } from '../db/database';
import type { BatchItemRow, BatchRow } from './types';

export class BatchesRepository {
  constructor(private readonly db: Database) {}

  async create(input: {
    organisationId: string;
    name: string;
    projectId?: string | null;
    createdBy: string;
  }): Promise<BatchRow> {
    const row: BatchRow = {
      id: newId(),
      organisation_id: input.organisationId,
      name: input.name,
      project_id: input.projectId ?? null,
      created_by: input.createdBy,
      created_at: nowIso(),
    };
    await this.db.execute(
      `INSERT INTO batches (id, organisation_id, name, project_id, created_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [row.id, row.organisation_id, row.name, row.project_id, row.created_by, row.created_at],
    );
    return row;
  }

  findById(organisationId: string, id: string): Promise<BatchRow | null> {
    return this.db.one<BatchRow>('SELECT * FROM batches WHERE organisation_id = ? AND id = ?', [
      organisationId,
      id,
    ]);
  }

  list(organisationId: string, limit = 25): Promise<BatchRow[]> {
    return this.db.query<BatchRow>(
      'SELECT * FROM batches WHERE organisation_id = ? ORDER BY created_at DESC LIMIT ?',
      [organisationId, limit],
    );
  }

  async addItem(input: {
    batchId: string;
    documentId: string | null;
    position: number;
    filename?: string | null;
    error?: string | null;
  }): Promise<BatchItemRow> {
    const row: BatchItemRow = {
      id: newId(),
      batch_id: input.batchId,
      document_id: input.documentId,
      position: input.position,
      filename: input.filename ?? null,
      error: input.error ?? null,
      created_at: nowIso(),
    };
    await this.db.execute(
      `INSERT INTO batch_items (id, batch_id, document_id, position, filename, error, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        row.id,
        row.batch_id,
        row.document_id,
        row.position,
        row.filename,
        row.error,
        row.created_at,
      ],
    );
    return row;
  }

  items(batchId: string): Promise<BatchItemRow[]> {
    return this.db.query<BatchItemRow>(
      'SELECT * FROM batch_items WHERE batch_id = ? ORDER BY position',
      [batchId],
    );
  }
}
