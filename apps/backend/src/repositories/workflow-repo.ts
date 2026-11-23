import { newId } from '@idcp/shared/ids';
import type { Database } from '../db/database';
import { nowIso } from '../db/database';

export interface WorkflowRow {
  id: string;
  organisation_id: string;
  name: string;
  trigger_event: string;
  document_type: string | null;
  conditions: string;
  actions: string;
  approval_policy: string;
  enabled: number;
  created_by: string;
  created_at: string;
  updated_at: string;
}

export interface WorkflowRunRow {
  id: string;
  organisation_id: string;
  workflow_id: string;
  document_id: string | null;
  trigger_event: string;
  status: 'matched' | 'skipped' | 'awaiting_approval' | 'completed' | 'failed';
  matched: number;
  explanation: string;
  actions: string;
  outputs: string;
  failure: string | null;
  approved_by: string | null;
  approved_at: string | null;
  created_at: string;
  execution_protocol: number;
  approval_snapshot: string | null;
}

/** AGENT-001: workflow definitions and the run log. */
export class WorkflowsRepository {
  constructor(private readonly db: Database) {}

  list(organisationId: string): Promise<WorkflowRow[]> {
    return this.db.query<WorkflowRow>(
      'SELECT * FROM workflows WHERE organisation_id = ? ORDER BY created_at DESC',
      [organisationId],
    );
  }

  findById(organisationId: string, id: string): Promise<WorkflowRow | null> {
    return this.db.one<WorkflowRow>(
      'SELECT * FROM workflows WHERE organisation_id = ? AND id = ?',
      [organisationId, id],
    );
  }

  /** Lock the definition through database-local execution, serializing disable and deletion. */
  lockForExecution(organisationId: string, id: string): Promise<WorkflowRow | null> {
    const lock = this.db.driver === 'postgres' ? ' FOR UPDATE' : '';
    return this.db.one<WorkflowRow>(
      `SELECT * FROM workflows WHERE organisation_id = ? AND id = ?${lock}`,
      [organisationId, id],
    );
  }

  /** Enabled rules that could apply to this trigger; conditions are evaluated by the engine. */
  async candidates(organisationId: string, trigger: string): Promise<WorkflowRow[]> {
    return this.db.query<WorkflowRow>(
      `SELECT * FROM workflows
        WHERE organisation_id = ? AND trigger_event = ? AND enabled = 1
        ORDER BY created_at ASC`,
      [organisationId, trigger],
    );
  }

  async create(input: {
    organisationId: string;
    name: string;
    trigger: string;
    documentType: string | null;
    conditions: unknown;
    actions: unknown;
    approvalPolicy: string;
    createdBy: string;
  }): Promise<WorkflowRow> {
    const now = nowIso();
    const row: WorkflowRow = {
      id: newId(),
      organisation_id: input.organisationId,
      name: input.name,
      trigger_event: input.trigger,
      document_type: input.documentType,
      conditions: JSON.stringify(input.conditions),
      actions: JSON.stringify(input.actions),
      approval_policy: input.approvalPolicy,
      enabled: 1,
      created_by: input.createdBy,
      created_at: now,
      updated_at: now,
    };

    await this.db.execute(
      `INSERT INTO workflows (id, organisation_id, name, trigger_event, document_type, conditions,
        actions, approval_policy, enabled, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        row.id,
        row.organisation_id,
        row.name,
        row.trigger_event,
        row.document_type,
        row.conditions,
        row.actions,
        row.approval_policy,
        row.enabled,
        row.created_by,
        row.created_at,
        row.updated_at,
      ],
    );
    return row;
  }

  async setEnabled(
    organisationId: string,
    id: string,
    enabled: boolean,
  ): Promise<WorkflowRow | null> {
    await this.db.execute(
      'UPDATE workflows SET enabled = ?, updated_at = ? WHERE organisation_id = ? AND id = ?',
      [enabled ? 1 : 0, nowIso(), organisationId, id],
    );
    return this.findById(organisationId, id);
  }

  async delete(organisationId: string, id: string): Promise<void> {
    await this.db.execute('DELETE FROM workflows WHERE organisation_id = ? AND id = ?', [
      organisationId,
      id,
    ]);
  }
}

/** The run log: what each workflow saw, what it decided and what happened next. */
export class WorkflowRunsRepository {
  constructor(private readonly db: Database) {}

  async create(input: {
    organisationId: string;
    workflowId: string;
    documentId: string | null;
    trigger: string;
    status: WorkflowRunRow['status'];
    matched: boolean;
    explanation: string;
    actions: unknown;
    outputs?: unknown;
    failure?: string | null;
    executionProtocol?: number;
    approvalSnapshot?: {
      reviewId: string;
      extractionId: string;
      conditionSemanticsVersion: number;
    } | null;
  }): Promise<WorkflowRunRow> {
    const row: WorkflowRunRow = {
      id: newId(),
      organisation_id: input.organisationId,
      workflow_id: input.workflowId,
      document_id: input.documentId,
      trigger_event: input.trigger,
      status: input.status,
      matched: input.matched ? 1 : 0,
      explanation: input.explanation,
      actions: JSON.stringify(input.actions ?? []),
      outputs: JSON.stringify(input.outputs ?? []),
      failure: input.failure ?? null,
      approved_by: null,
      approved_at: null,
      created_at: nowIso(),
      execution_protocol: input.executionProtocol ?? 0,
      approval_snapshot: input.approvalSnapshot ? JSON.stringify(input.approvalSnapshot) : null,
    };

    await this.db.execute(
      `INSERT INTO workflow_runs (id, organisation_id, workflow_id, document_id, trigger_event,
        status, matched, explanation, actions, outputs, failure, approved_by, approved_at,
        created_at, execution_protocol, approval_snapshot)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        row.id,
        row.organisation_id,
        row.workflow_id,
        row.document_id,
        row.trigger_event,
        row.status,
        row.matched,
        row.explanation,
        row.actions,
        row.outputs,
        row.failure,
        row.approved_by,
        row.approved_at,
        row.created_at,
        row.execution_protocol,
        row.approval_snapshot,
      ],
    );
    return row;
  }

  list(organisationId: string, limit = 50): Promise<WorkflowRunRow[]> {
    return this.db.query<WorkflowRunRow>(
      'SELECT * FROM workflow_runs WHERE organisation_id = ? ORDER BY created_at DESC LIMIT ?',
      [organisationId, Math.min(limit, 200)],
    );
  }

  findById(organisationId: string, id: string): Promise<WorkflowRunRow | null> {
    return this.db.one<WorkflowRunRow>(
      'SELECT * FROM workflow_runs WHERE organisation_id = ? AND id = ?',
      [organisationId, id],
    );
  }

  /** Lock within a transaction before executing a run; SQLite transactions begin IMMEDIATE. */
  lockForExecution(organisationId: string, id: string): Promise<WorkflowRunRow | null> {
    const lock = this.db.driver === 'postgres' ? ' FOR UPDATE' : '';
    return this.db.one<WorkflowRunRow>(
      `SELECT * FROM workflow_runs WHERE organisation_id = ? AND id = ?${lock}`,
      [organisationId, id],
    );
  }

  completeExecution(
    organisationId: string,
    id: string,
    expectedStatus: 'matched' | 'awaiting_approval',
    outputs: string[],
    approvedBy: string | null,
  ): Promise<WorkflowRunRow | null> {
    return this.db.one<WorkflowRunRow>(
      `UPDATE workflow_runs SET status = 'completed', outputs = ?, failure = NULL,
         approved_by = ?, approved_at = ?
       WHERE organisation_id = ? AND id = ? AND status = ? RETURNING *`,
      [
        JSON.stringify(outputs),
        approvedBy,
        approvedBy ? nowIso() : null,
        organisationId,
        id,
        expectedStatus,
      ],
    );
  }

  /** A stale failure may not overwrite another execution's completed result. */
  markFailedIfStatus(
    organisationId: string,
    id: string,
    expectedStatus: 'matched' | 'awaiting_approval',
    failure: string,
  ): Promise<WorkflowRunRow | null> {
    return this.db.one<WorkflowRunRow>(
      `UPDATE workflow_runs SET status = 'failed', failure = ?
       WHERE organisation_id = ? AND id = ? AND status = ? RETURNING *`,
      [failure.slice(0, 500), organisationId, id, expectedStatus],
    );
  }
}
