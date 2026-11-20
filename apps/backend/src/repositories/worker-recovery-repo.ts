import { nowIso, toJson, type Database } from '../db/database';
import { newId } from '@idcp/shared/ids';

type RecoveryInput = {
  id: string;
  attempt: number;
  operatorReference: string;
  incidentReference: string;
};

function validateInput(input: RecoveryInput): void {
  const reference = /^[a-zA-Z0-9][a-zA-Z0-9_.:@/-]{0,79}$/;
  if (
    typeof input.id !== 'string' ||
    input.id.length === 0 ||
    input.id.length > 256 ||
    !Number.isSafeInteger(input.attempt) ||
    input.attempt < 1 ||
    typeof input.operatorReference !== 'string' ||
    typeof input.incidentReference !== 'string' ||
    !reference.test(input.operatorReference) ||
    !reference.test(input.incidentReference)
  )
    throw new Error('Invalid recovery input');
}

/**
 * Operator-directed recovery: the assertion that all writers are offline is external to the DB.
 * The guarded update and audit entry commit together; this is not a claim lease or a safety proof.
 */
export class WorkerRecoveryRepository {
  constructor(private readonly db: Database) {}

  async requeueWithAudit(input: RecoveryInput): Promise<boolean> {
    validateInput(input);
    return this.db.transaction(async (tx) => {
      const now = nowIso();
      const row = await tx.one<{ organisation_id: string; type: string }>(
        `UPDATE jobs SET status = 'queued', run_after = ?, last_error = ?
         WHERE id = ? AND status = 'running' AND attempts = ?
         RETURNING organisation_id, type`,
        [now, 'Requeued by operator after offline review.', input.id, input.attempt],
      );
      if (!row) return false;
      await tx.execute(
        `INSERT INTO audit_logs (id, organisation_id, actor_type, actor_id, action, target_type, target_id, metadata, created_at)
         VALUES (?, ?, 'system', NULL, 'worker.job_requeued_offline', 'job', ?, ?, ?)`,
        [
          newId(),
          row.organisation_id,
          input.id,
          toJson({
            jobType:
              row.type === 'extract_document' || row.type === 'retention_purge'
                ? row.type
                : 'unknown',
            attempt: input.attempt,
            operatorReference: input.operatorReference,
            incidentReference: input.incidentReference,
          }),
          now,
        ],
      );
      return true;
    });
  }

  /**
   * Mark one reviewed interrupted claim dead without executing or retrying it. The caller must
   * actually stop all workers and review external effects; no database check can prove that.
   */
  async abandonWithAudit(
    input: RecoveryInput,
  ): Promise<{ abandoned: boolean; documentFailed: boolean }> {
    validateInput(input);
    return this.db.transaction(async (tx) => {
      const now = nowIso();
      // The guarded UPDATE takes the job lock first, matching current worker lock order.
      const row = await tx.one<{
        organisation_id: string;
        type: string;
        document_id: string | null;
      }>(
        `UPDATE jobs SET status = 'dead', finished_at = ?, run_after = NULL, last_error = ?
         WHERE id = ? AND status = 'running' AND attempts = ?
           AND type IN ('extract_document', 'retention_purge')
         RETURNING organisation_id, type, document_id`,
        [now, 'Abandoned by operator after offline review; not retried.', input.id, input.attempt],
      );
      if (!row) return { abandoned: false, documentFailed: false };

      let documentFailed = false;
      if (row.type === 'extract_document' && row.document_id) {
        const lock = tx.driver === 'postgres' ? ' FOR UPDATE' : '';
        const document = await tx.one<{ id: string }>(
          `SELECT id FROM documents WHERE organisation_id = ? AND id = ?${lock}`,
          [row.organisation_id, row.document_id],
        );
        if (document) {
          // Do not infer ownership of a document with any other extraction history, even a
          // completed job. Leave ambiguous or final document states untouched for investigation.
          const updated = await tx.one<{ id: string }>(
            `UPDATE documents SET status = 'failed', updated_at = ?
             WHERE organisation_id = ? AND id = ? AND deleted_at IS NULL
               AND status IN ('queued', 'processing')
               AND NOT EXISTS (SELECT 1 FROM jobs WHERE document_id = ?
                 AND type = 'extract_document' AND id <> ?)
             RETURNING id`,
            [now, row.organisation_id, row.document_id, row.document_id, input.id],
          );
          documentFailed = updated !== null;
        }
      }
      await tx.execute(
        `INSERT INTO audit_logs (id, organisation_id, actor_type, actor_id, action, target_type, target_id, metadata, created_at)
         VALUES (?, ?, 'system', NULL, 'worker.job_abandoned_offline', 'job', ?, ?, ?)`,
        [
          newId(),
          row.organisation_id,
          input.id,
          toJson({
            jobType: row.type,
            attempt: input.attempt,
            operatorReference: input.operatorReference,
            incidentReference: input.incidentReference,
            documentFailed,
          }),
          now,
        ],
      );
      return { abandoned: true, documentFailed };
    });
  }
}
