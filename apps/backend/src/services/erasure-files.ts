import { nowIso } from '../db/database';
import type { Logger } from '../logger';
import type { Storage } from '../storage';
import type { ErasureFilesRepository } from '../repositories/erasure-files-repo';

export type ErasureFileQueue = Pick<
  ErasureFilesRepository,
  'listPending' | 'isReferenced' | 'complete' | 'recordFailedAttempt'
>;

/**
 * Retry durable erasure work. Storage.delete must be idempotent: if the process dies after the
 * file is removed but before its queue row is deleted, the same key is attempted again. Concurrent
 * processors can attempt the same row; the reference check and storage deletion are not atomic with
 * other writers. Key reuse, filesystem replacement and external copies remain unresolved risks.
 */
export async function processErasureFiles(
  deletions: ErasureFileQueue,
  storage: Storage,
  logger: Logger,
  options: { userId?: string; limit?: number } = {},
): Promise<number> {
  const rows = await deletions.listPending(options);
  let completed = 0;
  for (const row of rows) {
    try {
      // Fail closed on known document, page, export or template references across tenants.
      if (await deletions.isReferenced(row.storage_key)) {
        throw new Error('File is referenced by another document');
      }
      await storage.delete(row.storage_key);
      await deletions.complete(row.id);
      completed += 1;
    } catch {
      // Do not record provider error text or paths in logs; these can contain sensitive data.
      await deletions.recordFailedAttempt(row.id, nowIso());
      logger.warn('erasure file deletion remains pending', { deletionId: row.id });
    }
  }
  return completed;
}
