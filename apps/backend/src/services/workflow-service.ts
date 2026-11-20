import { AppError, roleAtLeast, type DocumentType } from '@idcp/shared';
import type { Logger } from '../logger';
import type { DocumentsRepository, ExtractionsRepository } from '../repositories/document-repo';
import type { AuditRepository } from '../repositories/system-repo';
import type {
  WorkflowRunsRepository,
  WorkflowsRepository,
  WorkflowRow,
  WorkflowRunRow,
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
export interface WorkflowServiceRepositories {
  workflows: Pick<
    WorkflowsRepository,
    'list' | 'create' | 'setEnabled' | 'delete' | 'findById' | 'candidates'
  >;
  runs: Pick<
    WorkflowRunsRepository,
    'create' | 'findById' | 'list' | 'markApproved' | 'markFailed' | 'recordOutputs'
  >;
  documents: Pick<DocumentsRepository, 'findById' | 'softDelete'>;
  extractions: Pick<ExtractionsRepository, 'findLatestForDocument'>;
  audit: Pick<AuditRepository, 'record'>;
}

export class WorkflowService {
  private readonly workflows: WorkflowServiceRepositories['workflows'];
  private readonly runs: WorkflowServiceRepositories['runs'];
  private readonly documents: WorkflowServiceRepositories['documents'];
  private readonly extractions: WorkflowServiceRepositories['extractions'];
  private readonly audit: WorkflowServiceRepositories['audit'];

  constructor(
    repositories: WorkflowServiceRepositories,
    private readonly logger: Logger,
  ) {
    this.workflows = repositories.workflows;
    this.runs = repositories.runs;
    this.documents = repositories.documents;
    this.extractions = repositories.extractions;
    this.audit = repositories.audit;
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

      // Validate the whole plan before executing anything. In particular, never report placeholder
      // delivery as success or delete a document before discovering a later unsupported action.
      const unavailable = plan.matched ? unsupportedActionFailure(plan.actions) : null;
      const status = !plan.matched
        ? 'skipped'
        : plan.needsApproval
          ? 'awaiting_approval'
          : unavailable
            ? 'failed'
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
        failure: status === 'failed' ? unavailable : null,
      });

      // A matched plan that needs nobody's approval runs now; its real outputs go in the log. A
      // failure is recorded against the run rather than thrown, so one broken rule cannot stop the
      // others from being evaluated.
      if (status === 'completed') {
        const outputs: string[] = [];
        try {
          for (const action of plan.actions) {
            outputs.push(await this.execute(run, action.type));
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
    const unavailable = unsupportedActionFailure(actions);
    if (unavailable) {
      await this.runs.markFailed(actor.organisationId, run.id, unavailable);
      throw new AppError('CONFLICT', unavailable);
    }
    const outputs: string[] = [];
    try {
      for (const action of actions) {
        outputs.push(await this.execute(run, action.type));
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
   * Only deletion is currently implemented. Other actions fail closed before execution until
   * delivery implementations and their retry/approval semantics are available.
   */
  private async execute(
    run: WorkflowRunRow,
    type: WorkflowPlan['actions'][number]['type'],
  ): Promise<string> {
    switch (type) {
      case 'notify':
      case 'send_to_connector':
      case 'create_export':
        throw new Error('This workflow action is not available; no actions were executed.');
      case 'delete_document':
        if (!run.document_id) throw new Error('The workflow run has no document to delete.');
        if (!(await this.documents.softDelete(run.organisation_id, run.document_id))) {
          throw new Error('The workflow document was not available for deletion.');
        }
        return `deleted document ${run.document_id}`;
      default:
        throw new Error(`Unknown action "${String(type)}".`);
    }
  }
}

/** Fail the whole plan before any action if a delivery action has no implementation. */
function unsupportedActionFailure(actions: WorkflowPlan['actions']): string | null {
  return actions.some((action) => action.type !== 'delete_document')
    ? 'This workflow includes an unavailable action; no actions were executed.'
    : null;
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
