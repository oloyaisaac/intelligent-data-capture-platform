import { newId } from '@idcp/shared/ids';
import { CONNECTOR_HEALTH_FAILURE, CONNECTOR_RUN_FAILURE } from '../domain/connector-errors';
import { nowIso, toJson, type Database } from '../db/database';

const PAGE_SIZE = 100;
// Use binary comparisons for identifiers and exact safe-message matching even when a database
// uses a case- or accent-insensitive default collation. Only these fixed SQL identifiers are used.
const binaryCollation = (db: Database) => (db.driver === 'postgres' ? '"C"' : 'BINARY');
type Scope = { organisationId: string; connectorId: string };
type ApplyInput = Scope & { operatorReference: string; incidentReference: string };

function validateScope(scope: Scope): void {
  const id = /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,255}$/;
  if (
    typeof scope.organisationId !== 'string' ||
    typeof scope.connectorId !== 'string' ||
    !id.test(scope.organisationId) ||
    !id.test(scope.connectorId)
  )
    throw new Error('Invalid scope');
}

function validateApply(input: ApplyInput): void {
  validateScope(input);
  const reference = /^[a-zA-Z0-9][a-zA-Z0-9_.:@/-]{0,79}$/;
  if (
    typeof input.operatorReference !== 'string' ||
    typeof input.incidentReference !== 'string' ||
    !reference.test(input.operatorReference) ||
    !reference.test(input.incidentReference)
  )
    throw new Error('Invalid reference');
}

function count(value: unknown): number {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0) throw new Error('Invalid count');
  return number;
}

/** Offline, operator-directed replacement of connector errors; never reads the original text. */
export class ConnectorErrorRemediationRepository {
  constructor(private readonly db: Database) {}

  async list(
    organisationId: string,
    after: string | null,
  ): Promise<{
    connectors: Array<{ connectorId: string }>;
    nextAfter: string | null;
  }> {
    validateScope({ organisationId, connectorId: after ?? 'start' });
    const collation = binaryCollation(this.db);
    const rows = await this.db.query<{ id: string }>(
      `SELECT c.id FROM connectors c WHERE c.organisation_id COLLATE ${collation} = ?
       ${after === null ? '' : `AND c.id COLLATE ${collation} > ?`}
       AND ((c.last_error IS NOT NULL AND c.last_error COLLATE ${collation} <> ?)
         OR EXISTS (SELECT 1 FROM connector_runs r WHERE r.organisation_id COLLATE ${collation} = c.organisation_id
           AND r.connector_id COLLATE ${collation} = c.id AND r.error IS NOT NULL AND r.error COLLATE ${collation} <> ?))
       ORDER BY c.id COLLATE ${collation} LIMIT ?`,
      [
        organisationId,
        ...(after === null ? [] : [after]),
        CONNECTOR_HEALTH_FAILURE,
        CONNECTOR_RUN_FAILURE,
        PAGE_SIZE + 1,
      ],
    );
    const page = rows.slice(0, PAGE_SIZE);
    return {
      connectors: page.map((row) => ({ connectorId: row.id })),
      nextAfter: rows.length > PAGE_SIZE ? page[page.length - 1]!.id : null,
    };
  }

  async check(
    scope: Scope,
  ): Promise<{ found: boolean; healthEligible: boolean; runEligible: number }> {
    validateScope(scope);
    const collation = binaryCollation(this.db);
    const connector = await this.db.one<{ eligible: number }>(
      `SELECT CASE WHEN last_error IS NOT NULL AND last_error COLLATE ${collation} <> ? THEN 1 ELSE 0 END AS eligible
       FROM connectors WHERE organisation_id COLLATE ${collation} = ? AND id COLLATE ${collation} = ?`,
      [CONNECTOR_HEALTH_FAILURE, scope.organisationId, scope.connectorId],
    );
    if (!connector) return { found: false, healthEligible: false, runEligible: 0 };
    const row = await this.db.one<{ count: string | number }>(
      `SELECT COUNT(*) AS count FROM connector_runs WHERE organisation_id COLLATE ${collation} = ? AND connector_id COLLATE ${collation} = ?
       AND error IS NOT NULL AND error COLLATE ${collation} <> ?`,
      [scope.organisationId, scope.connectorId, CONNECTOR_RUN_FAILURE],
    );
    if (!row) throw new Error('Missing count');
    return {
      found: true,
      healthEligible: Number(connector.eligible) === 1,
      runEligible: count(row.count),
    };
  }

  async apply(input: ApplyInput): Promise<{
    found: boolean;
    healthChanged: boolean;
    runsChanged: number;
    remaining: boolean;
  }> {
    validateApply(input);
    return this.db.transaction(async (tx) => {
      const lock = tx.driver === 'postgres' ? ' FOR UPDATE' : '';
      const collation = binaryCollation(tx);
      const connector = await tx.one<{ id: string }>(
        `SELECT id FROM connectors WHERE organisation_id COLLATE ${collation} = ? AND id COLLATE ${collation} = ?${lock}`,
        [input.organisationId, input.connectorId],
      );
      if (!connector)
        return { found: false, healthChanged: false, runsChanged: 0, remaining: false };
      const health = await tx.one<{ id: string }>(
        `UPDATE connectors SET last_error = ? WHERE organisation_id COLLATE ${collation} = ? AND id COLLATE ${collation} = ?
         AND last_error IS NOT NULL AND last_error COLLATE ${collation} <> ? RETURNING id`,
        [
          CONNECTOR_HEALTH_FAILURE,
          input.organisationId,
          input.connectorId,
          CONNECTOR_HEALTH_FAILURE,
        ],
      );
      const rows = await tx.query<{ id: string }>(
        `SELECT id FROM connector_runs WHERE organisation_id COLLATE ${collation} = ? AND connector_id COLLATE ${collation} = ?
         AND error IS NOT NULL AND error COLLATE ${collation} <> ? ORDER BY id COLLATE ${collation} LIMIT ?`,
        [input.organisationId, input.connectorId, CONNECTOR_RUN_FAILURE, PAGE_SIZE],
      );
      let runsChanged = 0;
      for (const row of rows) {
        const updated = await tx.one<{ id: string }>(
          `UPDATE connector_runs SET error = ? WHERE organisation_id COLLATE ${collation} = ? AND connector_id COLLATE ${collation} = ?
           AND id COLLATE ${collation} = ? AND error IS NOT NULL AND error COLLATE ${collation} <> ? RETURNING id`,
          [
            CONNECTOR_RUN_FAILURE,
            input.organisationId,
            input.connectorId,
            row.id,
            CONNECTOR_RUN_FAILURE,
          ],
        );
        if (updated) runsChanged += 1;
      }
      const more = await tx.one<{ id: string }>(
        `SELECT id FROM connector_runs WHERE organisation_id COLLATE ${collation} = ? AND connector_id COLLATE ${collation} = ?
         AND error IS NOT NULL AND error COLLATE ${collation} <> ? LIMIT 1`,
        [input.organisationId, input.connectorId, CONNECTOR_RUN_FAILURE],
      );
      if (health || runsChanged) {
        await tx.execute(
          `INSERT INTO audit_logs (id, organisation_id, actor_type, actor_id, action, target_type, target_id, metadata, created_at)
           VALUES (?, ?, 'system', NULL, 'connector.errors_remediated_offline', 'connector', ?, ?, ?)`,
          [
            newId(),
            input.organisationId,
            input.connectorId,
            toJson({
              healthChanged: !!health,
              runsChanged,
              operatorReference: input.operatorReference,
              incidentReference: input.incidentReference,
            }),
            nowIso(),
          ],
        );
      }
      return { found: true, healthChanged: !!health, runsChanged, remaining: !!more };
    });
  }
}
