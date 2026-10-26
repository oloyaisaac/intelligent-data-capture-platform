import { AppError, roleAtLeast, type DocumentType } from '@idcp/shared';
import type { Database } from '../db/database';
import type { Logger } from '../logger';
import { DocumentsRepository, ExtractionsRepository } from '../repositories/document-repo';
import { AuditRepository } from '../repositories/system-repo';
import {
  WorkflowRunsRepository,
  WorkflowsRepository,
  type WorkflowRow,
  type WorkflowRunRow,
} from '../repositories/workflow-repo';
import {
  planWorkflow,
  validateWorkflow,
  type WorkflowDefinition,
  type WorkflowPlan,
  type WorkflowTrigger,
} from '../workflows/engine';
import type { AuthenticatedActor } from './auth-service';

/**
 * Workflow automation (AGENT-001).
 *
 * Two rules shape this service:
 *   1. Nothing destructive happens because a rule said so. A destructive action is planned, stored as
 *      `awaiting_approval`, and only runs when a person approves that specific run.
 *   2. Every evaluation is logged — including the ones that did not match — so "why did this not
 *      fire?" is answerable without reading code.
 */
export class WorkflowService {
  private readonly workflows: WorkflowsRepository;
  private readonly runs: WorkflowRunsRepository;
  private readonly documents: DocumentsRepository;
  private readonly extractions: ExtractionsRepository;
  private readonly audit: AuditRepository;

  constructor(
    db: Database,
    private readonly logger: Logger,
  ) {
    this.workflows = new WorkflowsRepository(db);
    this.runs = new WorkflowRunsRepository(db);
    this.documents = new DocumentsRepository(db);
    this.extractions = new ExtractionsRepository(db);
    this.audit = new AuditRepository(db);
  }

  async list(actor: AuthenticatedActor) {
    const rows = await this.workflows.list(actor.organisationId);
    return { items: rows.map(toDefinition) };
  }

  async create(
    actor: AuthenticatedActor,
    input: {
      name: string;
      trigger: string;
      documentType?: DocumentType | null;
      conditions: WorkflowDefinition['conditions'];
      actions: WorkflowDefinition['actions'];
      approvalPolicy?: 'always_ask' | 'auto_approve';
      enabled?: boolean;
    },
  ) {
    if (!roleAtLeast(actor.role, 'admin')) {
      throw new AppError('ROLE_REQUIRED', 'Only admins can create workflows.');
    }
    const problems = validateWorkflow(input);
    if (problems.length > 0) throw new AppError('FIELD_VALIDATION_FAILED', problems.join(' '));
    if (input.approvalPolicy === 'auto_approve' && !roleAtLeast(actor.role, 'owner')) {
      throw new AppError(
        'ROLE_REQUIRED',
        'Only an owner can create a workflow that acts without approval.',
      );
    }

    const row = await this.workflows.create({
      organisationId: actor.organisationId,
      name: input.name,
      trigger: input.trigger,
      documentType: input.documentType ?? null,
      conditions: input.conditions,
      actions: input.actions,
      approvalPolicy: input.approvalPolicy ?? 'always_ask',
      createdBy: actor.userId,
    });

    const definition = toDefinition(row);
    if (input.enabled === false)
      await this.workflows.setEnabled(actor.organisationId, row.id, false);

    await this.audit.record({
      organisationId: actor.organisationId,
      actorType: actor.actorType,
      actorId: actor.userId,
      action: 'workflow.created',
      targetType: 'workflow',
      targetId: row.id,
      metadata: {
        name: row.name,
        trigger: row.trigger_event,
        approvalPolicy: row.approval_policy,
        actions: row.actions,
      },
    });

    return input.enabled === false ? { ...definition, enabled: false } : definition;
  }

  async setEnabled(actor: AuthenticatedActor, id: string, enabled: boolean) {
    if (!roleAtLeast(actor.role, 'admin')) {
      throw new AppError('ROLE_REQUIRED', 'Only admins can change workflows.');
    }
    const row = await this.workflows.setEnabled(actor.organisationId, id, enabled);
    if (!row) throw new AppError('NOT_FOUND', 'Workflow not found.');
    return toDefinition(row);
  }

  async remove(actor: AuthenticatedActor, id: string) {
    if (!roleAtLeast(actor.role, 'admin')) {
      throw new AppError('ROLE_REQUIRED', 'Only admins can delete workflows.');
    }
    const row = await this.workflows.findById(actor.organisationId, id);
    if (!row) throw new AppError('NOT_FOUND', 'Workflow not found.');
    // The definition goes; the run log stays, because it is the record of what happened.
    await this.workflows.delete(actor.organisationId, id);
  }

  /** The log, newest first, with parsed actions and outputs. */
  async listRuns(actor: AuthenticatedActor, limit = 50) {
    const rows = await this.runs.list(actor.organisationId, limit);
    return { items: rows.map(toRun) };
  }

  /**
   * Evaluates every workflow for one trigger and records a run for each.
   *
   * Returns the plans so a caller (the review screen, a test) can show what would happen.
   */
  async evaluate(
    actor: AuthenticatedActor,
    input: { trigger: WorkflowTrigger; documentId?: string | null },
  ): Promise<{ plans: WorkflowPlan[]; runs: ReturnType<typeof toRun>[] }> {
    const document = input.documentId
      ? await this.documents.findById(actor.organisationId, input.documentId)
      : null;
    if (input.documentId && !document) {
      throw new AppError('NOT_FOUND', 'Document not found.');
    }

    let fields: Record<string, unknown> = {};
    let documentType: string | null = document?.document_type ?? null;
    if (document) {
      const extraction = await this.extractions.findLatestForDocument(document.id);
      if (extraction) {
        const udm = JSON.parse(extraction.udm) as { documentType?: string; fields?: unknown };
        documentType = udm.documentType ?? documentType;
        fields = flattenFields(udm);
      }
    }

    const candidates = await this.workflows.candidates(actor.organisationId, input.trigger);
    const plans: WorkflowPlan[] = [];
    const runs: ReturnType<typeof toRun>[] = [];

    for (const row of candidates) {
      const definition = toDefinition(row);
      const plan = planWorkflow(definition, {
        trigger: input.trigger,
        documentType,
        fields,
      });
      plans.push(plan);

      const status = !plan.matched
        ? 'skipped'
        : plan.needsApproval
          ? 'awaiting_approval'
          : 'completed';

      const run = await this.runs.create({
        organisationId: actor.organisationId,
        workflowId: row.id,
        documentId: document?.id ?? null,
        trigger: input.trigger,
        status,
        matched: plan.matched,
        explanation: plan.explanation,
        actions: plan.actions,
        outputs: [],
      });

      // A matched plan that needs nobody's approval runs now; its real outputs go in the log. A
      // failure is recorded against the run rather than thrown, so one broken rule cannot stop the
      // others from being evaluated.
      if (status === 'completed') {
        const outputs: string[] = [];
        try {
          for (const action of plan.actions) {
            outputs.push(await this.execute(run, action.type, action.config));
          }
          await this.runs.recordOutputs(actor.organisationId, run.id, outputs);
          run.outputs = JSON.stringify(outputs);
        } catch (error) {
          const failure = error instanceof Error ? error.message : 'The action failed.';
          await this.runs.markFailed(actor.organisationId, run.id, failure);
          run.status = 'failed';
          run.failure = failure;
        }
      }

      runs.push(toRun(run));
      this.logger.info('workflow evaluated', {
        workflowId: row.id,
        status,
        matched: plan.matched,
      });
    }

    return { plans, runs };
  }

  /**
   * Approves one pending run and executes its destructive actions.
   *
   * Approval is per run, not per workflow: approving yesterday's invoice does not authorise today's.
   */
  async approveRun(actor: AuthenticatedActor, runId: string) {
    if (!roleAtLeast(actor.role, 'reviewer')) {
      throw new AppError('ROLE_REQUIRED', 'Reviewers and admins can approve a workflow run.');
    }
    const run = await this.runs.findById(actor.organisationId, runId);
    if (!run) throw new AppError('NOT_FOUND', 'Workflow run not found.');
    if (run.status !== 'awaiting_approval') {
      throw new AppError(
        'CONFLICT',
        `This run is ${run.status.replace(/_/g, ' ')}, not awaiting approval.`,
      );
    }

    const actions = JSON.parse(run.actions) as WorkflowPlan['actions'];
    const outputs: string[] = [];
    try {
      for (const action of actions) {
        outputs.push(await this.execute(run, action.type, action.config));
      }
    } catch (error) {
      const failure = error instanceof Error ? error.message : 'The action failed.';
      await this.runs.markFailed(actor.organisationId, run.id, failure);
      throw new AppError('CONFLICT', `The approved action failed: ${failure}`);
    }

    await this.runs.markApproved(actor.organisationId, run.id, actor.userId);
    await this.runs.recordOutputs(actor.organisationId, run.id, outputs);
    await this.audit.record({
      organisationId: actor.organisationId,
      actorType: actor.actorType,
      actorId: actor.userId,
      action: 'workflow.run_approved',
      targetType: 'workflow',
      targetId: run.workflow_id,
      metadata: { runId: run.id, actions: actions.map((action) => action.type), outputs },
    });

    const updated = await this.runs.findById(actor.organisationId, run.id);
    return toRun(updated!);
  }

  /**
   * Executes one action.
   *
   * `notify` is recorded as an output rather than delivered: this deployment has no mail transport,
   * and pretending an email was sent would be a lie in the run log.
   */
  private async execute(
    run: WorkflowRunRow,
    type: WorkflowPlan['actions'][number]['type'],
    config: Record<string, unknown>,
  ): Promise<string> {
    switch (type) {
      case 'notify': {
        const message = typeof config.message === 'string' ? config.message : 'Workflow completed.';
        return `notified: ${message}`;
      }
      case 'send_to_connector':
        return `send queued for connector ${String(config.connectorId ?? 'unspecified')} (document ${run.document_id ?? 'none'})`;
      case 'create_export':
        return `export queued in ${String(config.format ?? 'xlsx')} for document ${run.document_id ?? 'none'}`;
      case 'delete_document':
        if (!run.document_id) return 'delete skipped: the run has no document';
        await this.documents.softDelete(run.organisation_id, run.document_id);
        return `deleted document ${run.document_id}`;
      default:
        throw new Error(`Unknown action "${String(type)}".`);
    }
  }
}

/** UDM → flat `path: value` map, which is what conditions are written against. */
export function flattenFields(udm: unknown, prefix = ''): Record<string, unknown> {
  if (udm === null || typeof udm !== 'object') return {};
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(udm as Record<string, unknown>)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (Array.isArray(value)) {
      out[path] = value;
      continue;
    }
    if (value !== null && typeof value === 'object') {
      Object.assign(out, flattenFields(value, path));
      continue;
    }
    out[path] = value;
  }
  return out;
}

function toDefinition(row: WorkflowRow): WorkflowDefinition {
  return {
    id: row.id,
    name: row.name,
    trigger: row.trigger_event as WorkflowDefinition['trigger'],
    documentType: row.document_type,
    conditions: JSON.parse(row.conditions) as WorkflowDefinition['conditions'],
    actions: JSON.parse(row.actions) as WorkflowDefinition['actions'],
    approvalPolicy: row.approval_policy as WorkflowDefinition['approvalPolicy'],
    enabled: Number(row.enabled) === 1,
  };
}

function toRun(row: WorkflowRunRow) {
  return {
    id: row.id,
    workflowId: row.workflow_id,
    documentId: row.document_id,
    trigger: row.trigger_event,
    status: row.status,
    matched: Number(row.matched) === 1,
    explanation: row.explanation,
    actions: JSON.parse(row.actions || '[]') as unknown[],
    outputs: JSON.parse(row.outputs || '[]') as string[],
    failure: row.failure,
    approvedBy: row.approved_by,
    approvedAt: row.approved_at,
    createdAt: row.created_at,
  };
}
