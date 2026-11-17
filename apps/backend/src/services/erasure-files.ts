import type { Database } from '../db/database';
import { nowIso } from '../db/database';
import type { Logger } from '../logger';
import type { Storage } from '../storage';

/**
 * Retry durable erasure work. Storage.delete must be idempotent: if the process dies after the
 * file is removed but before its queue row is deleted, the same key is attempted again. Multiple
 * maintenance processes may safely attempt the same key; storage keys must never be reused.
 */
export async function processErasureFiles(
  db: Database,
  storage: Storage,
  logger: Logger,
  options: { userId?: string; limit?: number } = {},
): Promise<number> {
  const rows = await db.query<{ id: string; storage_key: string }>(
    `SELECT id, storage_key FROM erasure_file_deletions
      ${options.userId ? 'WHERE user_id = ?' : ''}
      ORDER BY COALESCE(last_attempt_at, created_at), id LIMIT ?`,
    options.userId ? [options.userId, options.limit ?? 100] : [options.limit ?? 100],
  );
  let completed = 0;
  for (const row of rows) {
    try {
      // Never remove a file still referenced by a retained document, including page files.
      const referenced = await db.one(
        `SELECT storage_key FROM documents WHERE storage_key = ?
         UNION ALL SELECT storage_key FROM document_pages WHERE storage_key = ? LIMIT 1`,
        [row.storage_key, row.storage_key],
      );
      if (referenced) throw new Error('File is referenced by another document');
      await storage.delete(row.storage_key);
      await db.execute('DELETE FROM erasure_file_deletions WHERE id = ?', [row.id]);
      completed += 1;
    } catch {
      // Do not record provider error text or paths in logs; these can contain sensitive data.
      await db.execute(
        'UPDATE erasure_file_deletions SET attempts = attempts + 1, last_attempt_at = ? WHERE id = ?',
        [nowIso(), row.id],
      );
      logger.warn('erasure file deletion remains pending', { deletionId: row.id });
    }
  }
  return completed;
}
