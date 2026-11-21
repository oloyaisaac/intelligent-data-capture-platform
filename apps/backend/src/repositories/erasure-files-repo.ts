import type { Database } from '../db/database';
import { hasPendingErasureReference, hasStorageReference } from './storage-references';

export interface ErasureFileRow {
  id: string;
  storage_key: string;
}

/** Persistence for the durable file-deletion queue. */
export class ErasureFilesRepository {
  constructor(private readonly db: Database) {}

  listPending(options: { userId?: string; limit?: number } = {}): Promise<ErasureFileRow[]> {
    const { userId, limit = 100 } = options;
    // Never turn an invalid user scope into a global sweep, or allow SQLite's negative LIMIT
    // semantics to make a supposedly bounded operation unbounded.
    if (userId !== undefined && (typeof userId !== 'string' || userId.trim().length === 0)) {
      throw new Error('Invalid erasure user scope.');
    }
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      throw new Error('Invalid erasure batch limit.');
    }
    const scoped = userId !== undefined;
    return this.db.query<ErasureFileRow>(
      `SELECT id, storage_key FROM erasure_file_deletions
        ${scoped ? 'WHERE user_id = ?' : ''}
        ORDER BY COALESCE(last_attempt_at, created_at), id LIMIT ?`,
      scoped ? [userId, limit] : [limit],
    );
  }

  /**
   * Recheck the selected row under a database write/row lock before deleting external bytes.
   * This coordinates current processors for the same queue row, not key reuse or other writers.
   */
  withLockedPending(
    selected: ErasureFileRow,
    run: (
      locked: Pick<ErasureFilesRepository, 'isReferenced' | 'hasOtherPendingErasure' | 'complete'>,
    ) => Promise<void>,
  ): Promise<boolean> {
    return this.db.transaction(async (tx) => {
      const lock = tx.driver === 'postgres' ? ' FOR UPDATE' : '';
      const current = await tx.one<ErasureFileRow>(
        `SELECT id, storage_key FROM erasure_file_deletions WHERE id = ?${lock}`,
        [selected.id],
      );
      if (!current || current.storage_key !== selected.storage_key) return false;
      await run(new ErasureFilesRepository(tx));
      return true;
    });
  }

  isReferenced(key: string): Promise<boolean> {
    return hasStorageReference(this.db, key);
  }

  hasOtherPendingErasure(row: ErasureFileRow): Promise<boolean> {
    return hasPendingErasureReference(this.db, row.storage_key, row.id);
  }

  complete(id: string): Promise<void> {
    return this.db.execute('DELETE FROM erasure_file_deletions WHERE id = ?', [id]);
  }

  recordFailedAttempt(id: string, key: string, attemptedAt: string): Promise<void> {
    return this.db.execute(
      'UPDATE erasure_file_deletions SET attempts = attempts + 1, last_attempt_at = ? WHERE id = ? AND storage_key = ?',
      [attemptedAt, id, key],
    );
  }

  async countForUser(userId: string): Promise<number | null> {
    const row = await this.db.one<{ count: string | number }>(
      'SELECT COUNT(*) AS count FROM erasure_file_deletions WHERE user_id = ?',
      [userId],
    );
    return row ? Number(row.count) : null;
  }
}
