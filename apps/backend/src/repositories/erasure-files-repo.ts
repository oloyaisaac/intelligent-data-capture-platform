import type { Database } from '../db/database';

export interface ErasureFileRow {
  id: string;
  storage_key: string;
}

/** Persistence for the durable file-deletion queue. */
export class ErasureFilesRepository {
  constructor(private readonly db: Database) {}

  listPending(options: { userId?: string; limit?: number } = {}): Promise<ErasureFileRow[]> {
    return this.db.query<ErasureFileRow>(
      `SELECT id, storage_key FROM erasure_file_deletions
        ${options.userId ? 'WHERE user_id = ?' : ''}
        ORDER BY COALESCE(last_attempt_at, created_at), id LIMIT ?`,
      options.userId ? [options.userId, options.limit ?? 100] : [options.limit ?? 100],
    );
  }

  async isReferenced(key: string): Promise<boolean> {
    const row = await this.db.one(
      `SELECT storage_key FROM documents WHERE storage_key = ?
       UNION ALL SELECT storage_key FROM document_pages WHERE storage_key = ? LIMIT 1`,
      [key, key],
    );
    return row !== null;
  }

  complete(id: string): Promise<void> {
    return this.db.execute('DELETE FROM erasure_file_deletions WHERE id = ?', [id]);
  }

  recordFailedAttempt(id: string, attemptedAt: string): Promise<void> {
    return this.db.execute(
      'UPDATE erasure_file_deletions SET attempts = attempts + 1, last_attempt_at = ? WHERE id = ?',
      [attemptedAt, id],
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
