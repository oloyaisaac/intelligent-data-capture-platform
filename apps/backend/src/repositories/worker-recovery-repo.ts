import { nowIso, toJson, type Database } from '../db/database';
import { newId } from '@idcp/shared/ids';

/**
 * Operator-directed recovery: the assertion that all writers are offline is external to the DB.
 * The guarded update and audit entry commit together; this is not a claim lease or a safety proof.
 */
export class WorkerRecoveryRepository {
  constructor(private readonly db: Database) {}

  async requeueWithAudit(input: {
    id: string;
    attempt: number;
    operatorReference: string;
    incidentReference: string;
  }): Promise<boolean> {
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
}
