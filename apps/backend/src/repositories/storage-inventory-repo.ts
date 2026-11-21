import type { Database } from '../db/database';
import { hasPendingErasureReference, hasStorageReference } from './storage-references';

export type StorageReferenceKind = 'documents' | 'pages' | 'exports' | 'templates';
export interface StorageInventoryReference {
  id: string;
  storage_key: string;
  deleted_at: string | null;
}

/** Read-only observations, not proof of ownership or absence of external references. */
export class StorageInventoryRepository {
  constructor(private readonly db: Database) {}

  listReferences(
    organisationId: string,
    kind: StorageReferenceKind,
    after: string | null,
    limit: number,
  ): Promise<StorageInventoryReference[]> {
    const sources: Record<
      StorageReferenceKind,
      { from: string; id: string; key: string; deleted: string; org: string }
    > = {
      documents: {
        from: 'documents d',
        id: 'd.id',
        key: 'd.storage_key',
        deleted: 'd.deleted_at',
        org: 'd.organisation_id',
      },
      pages: {
        from: 'document_pages p JOIN documents d ON d.id = p.document_id',
        id: 'p.id',
        key: 'p.storage_key',
        deleted: 'd.deleted_at',
        org: 'd.organisation_id',
      },
      exports: {
        from: 'exports e',
        id: 'e.id',
        key: 'e.storage_key',
        deleted: 'NULL',
        org: 'e.organisation_id',
      },
      templates: {
        from: 'templates t',
        id: 't.id',
        key: 't.sample_storage_key',
        deleted: 'NULL',
        org: 't.organisation_id',
      },
    };
    const source = sources[kind];
    if (!source) throw new Error('Invalid reference kind');
    return this.db.query<StorageInventoryReference>(
      `SELECT ${source.id} AS id, ${source.key} AS storage_key, ${source.deleted} AS deleted_at FROM ${source.from}
       WHERE ${source.org} = ? AND ${source.key} IS NOT NULL ${after === null ? '' : `AND ${source.id} > ?`}
       ORDER BY ${source.id} LIMIT ?`,
      [organisationId, ...(after === null ? [] : [after]), limit],
    );
  }

  referenceMayExist(key: string): Promise<boolean> {
    // Also true for unsafe targets and when alias scanning reaches its fail-closed bound.
    return hasStorageReference(this.db, key);
  }

  pendingErasureMayExist(key: string): Promise<boolean> {
    return hasPendingErasureReference(this.db, key);
  }
}
