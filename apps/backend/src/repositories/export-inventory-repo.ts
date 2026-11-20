import type { Database } from '../db/database';
import { hasStorageReference } from './storage-references';

export interface InventoryExport {
  id: string;
  organisation_id: string;
  format: string;
  status: string;
  created_at: string;
  expires_at: string | null;
  storage_key: string | null;
}

/** Read-only, offline inventory. Results are point-in-time observations, not deletion authority. */
export class ExportInventoryRepository {
  constructor(private readonly db: Database) {}

  list(after: string | null, limit: number): Promise<InventoryExport[]> {
    return this.db.query<InventoryExport>(
      `SELECT id, organisation_id, format, status, created_at, expires_at, storage_key FROM exports
       ${after === null ? '' : 'WHERE id > ?'} ORDER BY id LIMIT ?`,
      after === null ? [limit] : [after, limit],
    );
  }

  find(id: string): Promise<InventoryExport | null> {
    return this.db.one<InventoryExport>(
      'SELECT id, organisation_id, format, status, created_at, expires_at, storage_key FROM exports WHERE id = ?',
      [id],
    );
  }

  referencedElsewhere(exportId: string, key: string): Promise<boolean> {
    return hasStorageReference(this.db, key, { exportId });
  }

  async pendingErasure(key: string): Promise<boolean> {
    return (
      (await this.db.one('SELECT id FROM erasure_file_deletions WHERE storage_key = ? LIMIT 1', [
        key,
      ])) !== null
    );
  }
}
