import { newId } from '@idcp/shared/ids';
import { nowIso, toJson, type Database } from '../db/database';
import { SAFE_WORKER_ERRORS, WORKER_ERROR_REDACTED } from '../domain/worker-errors';

const PAGE_SIZE = 100;
const placeholders = SAFE_WORKER_ERRORS.map(() => '?').join(', ');
const binaryCollation = (db: Database) => (db.driver === 'postgres' ? '"C"' : 'BINARY');
type Scope = { organisationId: string; jobId: string };
type ApplyInput = Scope & { operatorReference: string; incidentReference: string };

function validateScope(scope: Scope): void {
  const id = /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,255}$/;
  if (
    typeof scope.organisationId !== 'string' ||
    typeof scope.jobId !== 'string' ||
    !id.test(scope.organisationId) ||
    !id.test(scope.jobId)
  )
    throw new Error('Invalid scope');
}
function validateApply(input: ApplyInput): void {
  validateScope(input);
  const ref = /^[a-zA-Z0-9][a-zA-Z0-9_.:@/-]{0,79}$/;
  if (
    typeof input.operatorReference !== 'string' ||
    typeof input.incidentReference !== 'string' ||
    !ref.test(input.operatorReference) ||
    !ref.test(input.incidentReference)
  )
    throw new Error('Invalid reference');
}

/** Offline remediation of one job error; no original error or payload is selected or returned. */
export class WorkerErrorRemediationRepository {
  constructor(private readonly db: Database) {}

  async list(
    organisationId: string,
    after: string | null,
  ): Promise<{ jobs: Array<{ jobId: string }>; nextAfter: string | null }> {
    validateScope({ organisationId, jobId: after ?? 'start' });
    const collation = binaryCollation(this.db);
    const rows = await this.db.query<{ id: string }>(
      `SELECT id FROM jobs WHERE organisation_id COLLATE ${collation} = ?
       ${after === null ? '' : `AND id COLLATE ${collation} > ?`}
       AND last_error IS NOT NULL AND last_error COLLATE ${collation} NOT IN (${placeholders})
       ORDER BY id COLLATE ${collation} LIMIT ?`,
      [organisationId, ...(after === null ? [] : [after]), ...SAFE_WORKER_ERRORS, PAGE_SIZE + 1],
    );
    const page = rows.slice(0, PAGE_SIZE);
    return {
      jobs: page.map((row) => ({ jobId: row.id })),
      nextAfter: rows.length > PAGE_SIZE ? page[page.length - 1]!.id : null,
    };
  }

  async check(scope: Scope): Promise<{ found: boolean; eligible: boolean }> {
    validateScope(scope);
    const collation = binaryCollation(this.db);
    const job = await this.db.one<{ eligible: number }>(
      `SELECT CASE WHEN last_error IS NOT NULL AND last_error COLLATE ${collation} NOT IN (${placeholders})
       THEN 1 ELSE 0 END AS eligible FROM jobs WHERE organisation_id COLLATE ${collation} = ? AND id COLLATE ${collation} = ?`,
      [...SAFE_WORKER_ERRORS, scope.organisationId, scope.jobId],
    );
    return { found: !!job, eligible: job !== null && Number(job.eligible) === 1 };
  }

  async apply(input: ApplyInput): Promise<{ found: boolean; changed: boolean }> {
    validateApply(input);
    return this.db.transaction(async (tx) => {
      const collation = binaryCollation(tx);
      const lock = tx.driver === 'postgres' ? ' FOR UPDATE' : '';
      const job = await tx.one<{ id: string }>(
        `SELECT id FROM jobs WHERE organisation_id COLLATE ${collation} = ? AND id COLLATE ${collation} = ?${lock}`,
        [input.organisationId, input.jobId],
      );
      if (!job) return { found: false, changed: false };
      const changed = await tx.one<{ id: string }>(
        `UPDATE jobs SET last_error = ? WHERE organisation_id COLLATE ${collation} = ? AND id COLLATE ${collation} = ?
         AND last_error IS NOT NULL AND last_error COLLATE ${collation} NOT IN (${placeholders}) RETURNING id`,
        [WORKER_ERROR_REDACTED, input.organisationId, input.jobId, ...SAFE_WORKER_ERRORS],
      );
      if (changed) {
        await tx.execute(
          `INSERT INTO audit_logs (id, organisation_id, actor_type, actor_id, action, target_type, target_id, metadata, created_at)
           VALUES (?, ?, 'system', NULL, 'worker.error_remediated_offline', 'job', ?, ?, ?)`,
          [
            newId(),
            input.organisationId,
            input.jobId,
            toJson({
              operatorReference: input.operatorReference,
              incidentReference: input.incidentReference,
            }),
            nowIso(),
          ],
        );
      }
      return { found: true, changed: !!changed };
    });
  }
}
