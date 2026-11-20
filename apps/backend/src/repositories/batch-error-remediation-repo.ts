import { newId } from '@idcp/shared/ids';
import { BATCH_FAILURE, SAFE_BATCH_ERRORS } from '../domain/batch-errors';
import { nowIso, toJson, type Database } from '../db/database';

// Match the current public response policy: null and empty errors are not displayed; only exact
// known messages remain unchanged. Never load or log arbitrary historical text in this tool.
const eligible = `error IS NOT NULL AND error <> ? AND error NOT IN (?, ?, ?, ?)`;
const eligibleParams = ['', ...SAFE_BATCH_ERRORS];
const PAGE_SIZE = 100;

type BatchScope = { organisationId: string; batchId: string };
type ApplyInput = BatchScope & { operatorReference: string; incidentReference: string };

function validateScope(scope: BatchScope): void {
  const id = /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,255}$/;
  if (
    typeof scope.organisationId !== 'string' ||
    typeof scope.batchId !== 'string' ||
    !id.test(scope.organisationId) ||
    !id.test(scope.batchId)
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

/** Operator-directed, per-batch remediation. Offline status and authorization are assertions. */
export class BatchErrorRemediationRepository {
  constructor(private readonly db: Database) {}

  /** Page through batches with eligible errors without reading or returning error values. */
  async list(
    organisationId: string,
    after: string | null,
  ): Promise<{ batches: Array<{ batchId: string; eligible: number }>; nextAfter: string | null }> {
    validateScope({ organisationId, batchId: after ?? 'start' });
    const rows = await this.db.query<{ batch_id: string; count: string | number }>(
      `SELECT b.id AS batch_id, COUNT(*) AS count FROM batches b
       JOIN batch_items i ON i.batch_id = b.id
       WHERE b.organisation_id = ? ${after === null ? '' : 'AND b.id > ?'} AND ${eligible}
       GROUP BY b.id ORDER BY b.id LIMIT ?`,
      [organisationId, ...(after === null ? [] : [after]), ...eligibleParams, PAGE_SIZE + 1],
    );
    const batches = rows.slice(0, PAGE_SIZE).map((row) => {
      const count = Number(row.count);
      if (!Number.isSafeInteger(count) || count < 1) throw new Error('Invalid count');
      return { batchId: row.batch_id, eligible: count };
    });
    return {
      batches,
      nextAfter: rows.length > PAGE_SIZE ? batches[batches.length - 1]!.batchId : null,
    };
  }

  async check(scope: BatchScope): Promise<{ found: boolean; eligible: number }> {
    validateScope(scope);
    const batch = await this.db.one<{ id: string }>(
      'SELECT id FROM batches WHERE organisation_id = ? AND id = ?',
      [scope.organisationId, scope.batchId],
    );
    if (!batch) return { found: false, eligible: 0 };
    const row = await this.db.one<{ count: string | number }>(
      `SELECT COUNT(*) AS count FROM batch_items WHERE batch_id = ? AND ${eligible}`,
      [scope.batchId, ...eligibleParams],
    );
    const count = Number(row?.count);
    if (!Number.isSafeInteger(count) || count < 0) throw new Error('Invalid count');
    return { found: true, eligible: count };
  }

  async apply(input: ApplyInput): Promise<{ found: boolean; changed: number; remaining: boolean }> {
    validateApply(input);
    return this.db.transaction(async (tx) => {
      const lock = tx.driver === 'postgres' ? ' FOR UPDATE' : '';
      const batch = await tx.one<{ id: string }>(
        `SELECT id FROM batches WHERE organisation_id = ? AND id = ?${lock}`,
        [input.organisationId, input.batchId],
      );
      if (!batch) return { found: false, changed: 0, remaining: false };
      const items = await tx.query<{ id: string }>(
        `SELECT id FROM batch_items WHERE batch_id = ? AND ${eligible} ORDER BY id LIMIT ?`,
        [input.batchId, ...eligibleParams, PAGE_SIZE],
      );
      let changed = 0;
      for (const item of items) {
        const updated = await tx.one<{ id: string }>(
          `UPDATE batch_items SET error = ? WHERE batch_id = ? AND id = ? AND ${eligible} RETURNING id`,
          [BATCH_FAILURE, input.batchId, item.id, ...eligibleParams],
        );
        if (updated) changed += 1;
      }
      const more = await tx.one<{ id: string }>(
        `SELECT id FROM batch_items WHERE batch_id = ? AND ${eligible} LIMIT 1`,
        [input.batchId, ...eligibleParams],
      );
      if (changed) {
        await tx.execute(
          `INSERT INTO audit_logs (id, organisation_id, actor_type, actor_id, action, target_type, target_id, metadata, created_at)
           VALUES (?, ?, 'system', NULL, 'batch.errors_remediated_offline', 'batch', ?, ?, ?)`,
          [
            newId(),
            input.organisationId,
            input.batchId,
            toJson({
              count: changed,
              operatorReference: input.operatorReference,
              incidentReference: input.incidentReference,
            }),
            nowIso(),
          ],
        );
      }
      return { found: true, changed, remaining: !!more };
    });
  }
}
