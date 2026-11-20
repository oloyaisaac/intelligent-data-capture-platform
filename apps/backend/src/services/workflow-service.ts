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
export interface WorkflowExecutionRepositories {
  runs: Pick<
    WorkflowRunsRepository,
    'lockForExecution' | 'completeExecution' | 'markFailedIfStatus'
  >;
  documents: Pick<DocumentsRepository, 'softDelete'>;
  audit: Pick<AuditRepository, 'record'>;
}

export interface WorkflowServiceRepositories {
  workflows: Pick<
    WorkflowsRepository,
    'list' | 'create' | 'setEnabled' | 'delete' | 'findById' | 'candidates'
  >;
  runs: Pick<WorkflowRunsRepository, 'create' | 'findById' | 'list' | 'markFailedIfStatus'>;
  documents: Pick<DocumentsRepository, 'findById'>;
  extractions: Pick<ExtractionsRepository, 'findLatestForDocument'>;
  audit: Pick<AuditRepository, 'record'>;
  transaction<T>(run: (repositories: WorkflowExecutionRepositories) => Promise<T>): Promise<T>;
}

export class WorkflowService {
  private readonly workflows: WorkflowServiceRepositories['workflows'];
  private readonly runs: WorkflowServiceRepositories['runs'];
  private readonly documents: WorkflowServiceRepositories['documents'];
  private readonly extractions: WorkflowServiceRepositories['extractions'];
  private readonly audit: WorkflowServiceRepositories['audit'];
  private readonly transaction: WorkflowServiceRepositories['transaction'];

  constructor(
    repositories: WorkflowServiceRepositories,
    private readonly logger: Logger,
  ) {
    this.workflows = repositories.workflows;
    this.runs = repositories.runs;
    this.documents = repositories.documents;
    this.extractions = repositories.extractions;
    this.audit = repositories.audit;
    this.transaction = repositories.transaction;
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

  /** Read one tenant-scoped run, including the immutable action plan, before recovery. */
  async getRun(actor: AuthenticatedActor, runId: string) {
    const run = await this.runs.findById(actor.organisationId, runId);
    if (!run) throw new AppError('NOT_FOUND', 'Workflow run not found.');
    return toRun(run);
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
            : 'matched';

      let run = await this.runs.create({
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
        // Only runs created under this version's transactional execution protocol are eligible
        // for owner-directed cancellation. Older and unknown runs remain operator-only cases.
        executionProtocol: status === 'matched' ? 1 : 0,
      });

      // A crash before execution leaves a matched run, never a false completed result.
      if (status === 'matched') {
        try {
          run = await this.executeRun(actor, run.id, 'matched');
        } catch (error) {
          if (!(error instanceof WorkflowActionFailure)) {
            throw new AppError('INTERNAL_ERROR', 'Workflow execution could not be confirmed.');
          }
          await this.runs.markFailedIfStatus(
            actor.organisationId,
            run.id,
            'matched',
            error.message,
          );
          const current = await this.runs.findById(actor.organisationId, run.id);
          if (!current) throw new AppError('INTERNAL_ERROR', 'Workflow run not found.');
          run = current;
        }
      }

      runs.push(toRun(run));
      this.logger.info('workflow evaluated', {
        workflowId: row.id,
        status: run.status,
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
    let run: WorkflowRunRow;
    try {
      run = await this.executeRun(actor, runId, 'awaiting_approval');
    } catch (error) {
      if (error instanceof WorkflowActionFailure) {
        await this.runs.markFailedIfStatus(
          actor.organisationId,
          runId,
          'awaiting_approval',
          error.message,
        );
        throw new AppError('CONFLICT', `The approved action failed: ${error.message}`);
      }
      if (error instanceof WorkflowRunNotFound)
        throw new AppError('NOT_FOUND', 'Workflow run not found.');
      if (error instanceof WorkflowRunUnavailable)
        throw new AppError('CONFLICT', 'This workflow run is no longer available for execution.');
      // A database/commit failure may be ambiguous; do not overwrite an already-committed result.
      throw new AppError('INTERNAL_ERROR', 'Workflow execution could not be confirmed.');
    }
    if (run.status === 'failed')
      throw new AppError('CONFLICT', run.failure ?? 'Workflow action failed.');
    return toRun(run);
  }

  /** Cancel a reviewed interrupted run without replaying its actions. */
  async cancelInterruptedRun(
    actor: AuthenticatedActor,
    runId: string,
    input: { confirmReviewed: boolean; incidentReference: string },
  ) {
    if (actor.actorType !== 'user' || !roleAtLeast(actor.role, 'owner')) {
      throw new AppError('ROLE_REQUIRED', 'Only a signed-in owner can cancel an interrupted run.');
    }
    if (
      input.confirmReviewed !== true ||
      typeof input.incidentReference !== 'string' ||
      !/^[a-zA-Z0-9][a-zA-Z0-9_.:@/-]{0,79}$/.test(input.incidentReference)
    ) {
      throw new AppError(
        'FIELD_VALIDATION_FAILED',
        'Confirm review and provide a valid non-secret incident reference.',
      );
    }
    try {
      const run = await this.transaction(async (repositories) => {
        const locked = await repositories.runs.lockForExecution(actor.organisationId, runId);
        if (!locked) throw new WorkflowRunNotFound();
        // Never apply this path to historical/old-binary records or inconsistent rows.
        if (
          locked.status !== 'matched' ||
          locked.execution_protocol !== 1 ||
          Number(locked.matched) !== 1 ||
          locked.approved_by !== null ||
          locked.approved_at !== null ||
          locked.failure !== null ||
          locked.outputs !== '[]'
        )
          throw new WorkflowRunUnavailable();
        const cancelled = await repositories.runs.markFailedIfStatus(
          actor.organisationId,
          runId,
          'matched',
          'Cancelled after owner review. Inspect history before creating another run.',
        );
        if (!cancelled) throw new WorkflowRunUnavailable();
        await repositories.audit.record({
          organisationId: actor.organisationId,
          actorType: actor.actorType,
          actorId: actor.userId,
          action: 'workflow.run_cancelled_interrupted',
          targetType: 'workflow',
          targetId: locked.workflow_id,
          metadata: { runId, incidentReference: input.incidentReference, executionProtocol: 1 },
        });
        return cancelled;
      });
      return toRun(run);
    } catch (error) {
      if (error instanceof WorkflowRunNotFound)
        throw new AppError('NOT_FOUND', 'Workflow run not found.');
      if (error instanceof WorkflowRunUnavailable)
        throw new AppError(
          'CONFLICT',
          'This run is not eligible for interrupted-run cancellation.',
        );
      throw new AppError('INTERNAL_ERROR', 'Workflow cancellation could not be confirmed.');
    }
  }

  /** Only database-local deletion is implemented. Do not add external effects to this transaction. */
  private async executeRun(
    actor: AuthenticatedActor,
    runId: string,
    expectedStatus: 'matched' | 'awaiting_approval',
  ): Promise<WorkflowRunRow> {
    return this.transaction(async (repositories) => {
      const run = await repositories.runs.lockForExecution(actor.organisationId, runId);
      if (!run) throw new WorkflowRunNotFound();
      if (run.status !== expectedStatus) throw new WorkflowRunUnavailable();
      const actions = JSON.parse(run.actions) as WorkflowPlan['actions'];
      const unavailable = unsupportedActionFailure(actions);
      if (unavailable) {
        const failed = await repositories.runs.markFailedIfStatus(
          actor.organisationId,
          run.id,
          expectedStatus,
          unavailable,
        );
        if (!failed) throw new WorkflowRunUnavailable();
        return failed;
      }
      const outputs: string[] = [];
      for (const action of actions) {
        // The preflight rejects everything except the database-local delete action.
        if (action.type !== 'delete_document')
          throw new WorkflowActionFailure('The workflow action is not available.');
        if (!run.document_id)
          throw new WorkflowActionFailure('The workflow run has no document to delete.');
        if (!(await repositories.documents.softDelete(run.organisation_id, run.document_id))) {
          throw new WorkflowActionFailure('The workflow document was not available for deletion.');
        }
        await repositories.audit.record({
          organisationId: actor.organisationId,
          actorType: actor.actorType,
          actorId: actor.userId,
          action: 'document.deleted',
          targetType: 'document',
          targetId: run.document_id,
          metadata: { workflowRunId: run.id },
        });
        outputs.push(`deleted document ${run.document_id}`);
      }
      const approvedBy = expectedStatus === 'awaiting_approval' ? actor.userId : null;
      const completed = await repositories.runs.completeExecution(
        actor.organisationId,
        run.id,
        expectedStatus,
        outputs,
        approvedBy,
      );
      if (!completed) throw new WorkflowRunUnavailable();
      await repositories.audit.record({
        organisationId: actor.organisationId,
        actorType: actor.actorType,
        actorId: actor.userId,
        action: approvedBy ? 'workflow.run_approved' : 'workflow.run_completed',
        targetType: 'workflow',
        targetId: run.workflow_id,
        metadata: { runId: run.id, actions: actions.map((action) => action.type), outputs },
      });
      return completed;
    });
  }
}

class WorkflowActionFailure extends Error {}
class WorkflowRunNotFound extends Error {}
class WorkflowRunUnavailable extends Error {}

/** Fail the whole plan before any action if a delivery action has no implementation. */
function unsupportedActionFailure(actions: WorkflowPlan['actions']): string | null {
  return !Array.isArray(actions) ||
    actions.length === 0 ||
    actions.some((action) => !action || action.type !== 'delete_document')
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
    executionProtocol: row.execution_protocol,
  };
}
