import { nowIso } from '../db/database';
import type { Logger } from '../logger';
import type { Storage } from '../storage';
import type { ErasureFilesRepository } from '../repositories/erasure-files-repo';

export type ErasureFileQueue = Pick<
  ErasureFilesRepository,
  'listPending' | 'withLockedPending' | 'recordFailedAttempt'
>;

/**
 * Retry durable erasure work. Storage.delete must be idempotent: if the process dies after the
 * file is removed but before its queue row is deleted, the same key is attempted again. Current
 * processors recheck and lock the same queue row before deletion and refuse known competing queue
 * rows. Reference checks and storage effects are not atomic with other writers. Concurrent queue
 * insertion, key reuse, old processors, filesystem replacement and external copies remain risks.
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
      const changed = await deletions.withLockedPending(row, async (locked) => {
        // Fail closed on known document, page, export or template references across tenants.
        if (
          (await locked.isReferenced(row.storage_key)) ||
          (await locked.hasOtherPendingErasure(row))
        ) {
          throw new Error('File has a conflicting reference or pending deletion');
        }
        await storage.delete(row.storage_key);
        await locked.complete(row.id);
      });
      if (changed) completed += 1;
    } catch {
      // Do not record provider error text or paths in logs; these can contain sensitive data.
      await deletions.recordFailedAttempt(row.id, row.storage_key, nowIso());
      logger.warn('erasure file deletion remains pending', { deletionId: row.id });
    }
  }
  return completed;
}
