import type { FastifyInstance } from 'fastify';
import { DOCUMENT_TYPES, badRequest, type DocumentType } from '@idcp/shared';
import type { Services } from '../../services/container';
import type { Guards } from '../guards';
import {
  CONDITION_OPERATORS,
  WORKFLOW_ACTIONS,
  WORKFLOW_TRIGGERS,
  type ConditionOperator,
  type WorkflowActionType,
  type WorkflowTrigger,
} from '../../workflows/engine';

/**
 * AGENT-001 — workflow rules and their run log.
 *
 * Evaluation is explicit (`POST /workflows/evaluate`) rather than hidden behind document approval.
 * It records runs and may execute owner-configured automatic actions; it is not a dry run.
 */
export function registerWorkflowRoutes(
  app: FastifyInstance,
  services: Services,
  guards: Guards,
): void {
  const parseDefinition = (body: unknown) => {
    const input = body as {
      name?: unknown;
      trigger?: unknown;
      documentType?: unknown;
      conditions?: unknown;
      actions?: unknown;
      approvalPolicy?: unknown;
      enabled?: unknown;
    };
    if (typeof input?.name !== 'string' || typeof input.trigger !== 'string') {
      throw badRequest('A workflow needs a name and a trigger.');
    }
    if (!(WORKFLOW_TRIGGERS as readonly string[]).includes(input.trigger)) {
      throw badRequest(`Trigger must be one of: ${WORKFLOW_TRIGGERS.join(', ')}.`);
    }

    const conditions = Array.isArray(input.conditions) ? input.conditions : [];
    const parsedConditions = conditions.map((entry) => {
      const condition = entry as { field?: unknown; operator?: unknown; value?: unknown };
      if (typeof condition?.field !== 'string' || typeof condition.operator !== 'string') {
        throw badRequest('Every condition needs a field and an operator.');
      }
      if (!(CONDITION_OPERATORS as readonly string[]).includes(condition.operator)) {
        throw badRequest(`Unknown operator "${condition.operator}".`);
      }
      return {
        field: condition.field,
        operator: condition.operator as ConditionOperator,
        ...(condition.value === undefined ? {} : { value: condition.value }),
      } as { field: string; operator: ConditionOperator; value?: never };
    });

    const actions = (Array.isArray(input.actions) ? input.actions : []).map((entry) => {
      const action = entry as { type?: unknown; config?: unknown };
      if (typeof action?.type !== 'string') throw badRequest('Every action needs a type.');
      if (!(WORKFLOW_ACTIONS as readonly string[]).includes(action.type)) {
        throw badRequest(`Unknown action "${action.type}".`);
      }
      return {
        type: action.type as WorkflowActionType,
        ...(action.config && typeof action.config === 'object'
          ? { config: action.config as Record<string, unknown> }
          : {}),
      };
    });

    const approvalPolicy =
      input.approvalPolicy === 'auto_approve' ? ('auto_approve' as const) : ('always_ask' as const);

    return {
      name: input.name,
      trigger: input.trigger,
      documentType:
        typeof input.documentType === 'string' &&
        (DOCUMENT_TYPES as readonly string[]).includes(input.documentType)
          ? (input.documentType as DocumentType)
          : null,
      conditions: parsedConditions,
      actions,
      approvalPolicy,
      enabled: input.enabled !== false,
    };
  };

  app.get('/workflows', async (request) => {
    const actor = await guards.authenticate(request);
    return services.workflows.list(actor);
  });

  app.post('/workflows', async (request, reply) => {
    const actor = await guards.authenticate(request);
    await guards.requireRole('admin')(request, reply);
    const parsed = parseDefinition(request.body);
    const created = await services.workflows.create(actor, {
      ...parsed,
      trigger: parsed.trigger as WorkflowTrigger,
    });
    return reply.code(201).send(created);
  });

  app.patch('/workflows/:id', async (request, reply) => {
    const actor = await guards.authenticate(request);
    await guards.requireRole('admin')(request, reply);
    const body = request.body as { enabled?: unknown };
    if (typeof body?.enabled !== 'boolean') {
      throw badRequest('Send { "enabled": true } or { "enabled": false }.');
    }
    return services.workflows.setEnabled(actor, guards.uuidParam(request), body.enabled);
  });

  app.delete('/workflows/:id', async (request, reply) => {
    const actor = await guards.authenticate(request);
    await guards.requireRole('admin')(request, reply);
    await services.workflows.remove(actor, guards.uuidParam(request));
    return reply.code(204).send();
  });

  app.get('/workflows/runs', async (request) => {
    const actor = await guards.authenticate(request);
    const query = request.query as { limit?: string };
    return services.workflows.listRuns(actor, Number(query.limit) || 50);
  });

  app.get('/workflows/runs/:id', async (request) => {
    const actor = await guards.authenticate(request);
    return services.workflows.getRun(actor, guards.uuidParam(request));
  });

  app.post('/workflows/runs/:id/cancel-interrupted', async (request) => {
    const actor = await guards.authenticate(request);
    const body = request.body as
      { confirmReviewed?: unknown; incidentReference?: unknown } | undefined;
    if (body?.confirmReviewed !== true || typeof body.incidentReference !== 'string') {
      throw badRequest('Confirm review and supply a non-secret incident reference.');
    }
    return services.workflows.cancelInterruptedRun(actor, guards.uuidParam(request), {
      confirmReviewed: true,
      incidentReference: body.incidentReference,
    });
  });

  /** Evaluates every enabled workflow for a trigger; the answers are logged, matched or not. */
  app.post('/workflows/evaluate', async (request) => {
    const actor = await guards.authenticate(request);
    const body = request.body as { trigger?: unknown; documentId?: unknown };
    if (typeof body?.trigger !== 'string') throw badRequest('Choose a trigger to evaluate.');
    if (!(WORKFLOW_TRIGGERS as readonly string[]).includes(body.trigger)) {
      throw badRequest(`Trigger must be one of: ${WORKFLOW_TRIGGERS.join(', ')}.`);
    }
    return services.workflows.evaluate(actor, {
      trigger: body.trigger as WorkflowTrigger,
      documentId: typeof body.documentId === 'string' && body.documentId ? body.documentId : null,
    });
  });

  app.post('/workflows/runs/:id/approve', async (request) => {
    const actor = await guards.authenticate(request);
    return services.workflows.approveRun(actor, guards.uuidParam(request));
  });
}
