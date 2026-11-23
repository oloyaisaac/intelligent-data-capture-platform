/**
 * Workflow rules and their safety policy (AGENT-001).
 *
 * A workflow is data: a trigger, a list of conditions over the document's fields, and a list of
 * actions. Everything in this file is pure, so the same rules decide the same outcome in a test, in
 * the worker and in the API.
 *
 * The one thing that is *not* data-driven is which actions are destructive. That list lives here, in
 * code, because a workflow must not be able to talk its way past the approval gate by describing a
 * deletion as something else.
 */

export const WORKFLOW_TRIGGERS = [
  'document.approved',
  'document.extracted',
  'document.needs_review',
  'batch.completed',
] as const;
export type WorkflowTrigger = (typeof WORKFLOW_TRIGGERS)[number];

export const WORKFLOW_ACTIONS = [
  'send_to_connector',
  'create_export',
  'notify',
  'delete_document',
] as const;
export type WorkflowActionType = (typeof WORKFLOW_ACTIONS)[number];

/**
 * Actions that change or destroy data outside the review screen. They always need a person's
 * approval unless the workflow explicitly opts in *and* the organisation's policy allows it.
 */
export const DESTRUCTIVE_ACTIONS: readonly WorkflowActionType[] = [
  'send_to_connector',
  'create_export',
  'delete_document',
];

export const CONDITION_OPERATORS = [
  'equals',
  'not_equals',
  'contains',
  'starts_with',
  'greater_than',
  'less_than',
  'exists',
  'in',
] as const;
export type ConditionOperator = (typeof CONDITION_OPERATORS)[number];

/** Version carried by approved-trigger plans created using these missing-value and operand guards. */
export const WORKFLOW_CONDITION_SEMANTICS_VERSION = 1 as const;

export interface WorkflowCondition {
  /** A UDM field path, e.g. `total.amount` or `documentType`. */
  field: string;
  operator: ConditionOperator;
  value?: string | number | boolean | string[];
}

export interface WorkflowAction {
  type: WorkflowActionType;
  /** Connector, export format, message text — whatever the action needs. */
  config?: Record<string, unknown>;
}

export interface WorkflowDefinition {
  id: string;
  name: string;
  trigger: WorkflowTrigger;
  documentType?: string | null;
  conditions: WorkflowCondition[];
  actions: WorkflowAction[];
  /**
   * `always_ask` (default) sends every destructive action to a person.
   * `auto_approve` lets destructive actions run unattended — only for workflows an admin marked so.
   */
  approvalPolicy: 'always_ask' | 'auto_approve';
  enabled: boolean;
}

export interface PlannedAction {
  type: WorkflowActionType;
  config: Record<string, unknown>;
  destructive: boolean;
  /** True when this action cannot run until somebody approves it. */
  requiresApproval: boolean;
  /** Why it needs approval, in words a person can act on. */
  reason: string | null;
}

export interface WorkflowPlan {
  workflowId: string;
  matched: boolean;
  /** Why the workflow did not match, or the reason it did. */
  explanation: string;
  actions: PlannedAction[];
  /** True when any planned action is waiting for a person. */
  needsApproval: boolean;
}

export interface ConditionContext {
  documentType?: string | null;
  trigger: WorkflowTrigger;
  /** Flat field map, e.g. `{ 'total.amount': 120, vendor: 'Acme' }`. */
  fields: Record<string, unknown>;
}

function asNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function asText(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  return String(value);
}

/** Evaluates one condition. Unknown operators fail closed — a rule never matches by accident. */
export function evaluateCondition(
  condition: WorkflowCondition,
  context: ConditionContext,
): boolean {
  const value =
    condition.field === 'documentType'
      ? context.documentType
      : Object.hasOwn(context.fields, condition.field)
        ? context.fields[condition.field]
        : undefined;
  const present = value !== null && value !== undefined && value !== '';
  // Missing values cannot establish a comparison, including not_equals and equality to null.
  if (!present) return false;
  // Absent operands previously made not_equals/contains/starts_with match arbitrary values.
  if (
    condition.operator !== 'exists' &&
    (condition.value === undefined || condition.value === null)
  )
    return false;

  switch (condition.operator) {
    case 'exists':
      return true;
    case 'equals':
      return compareEquals(value, condition.value);
    case 'not_equals':
      return !compareEquals(value, condition.value);
    case 'contains':
      return present && asText(value).toLowerCase().includes(asText(condition.value).toLowerCase());
    case 'starts_with':
      return (
        present && asText(value).toLowerCase().startsWith(asText(condition.value).toLowerCase())
      );
    case 'greater_than': {
      const left = asNumber(value);
      const right = asNumber(condition.value);
      return left !== null && right !== null && left > right;
    }
    case 'less_than': {
      const left = asNumber(value);
      const right = asNumber(condition.value);
      return left !== null && right !== null && left < right;
    }
    case 'in': {
      const list = Array.isArray(condition.value)
        ? condition.value
        : asText(condition.value)
            .split(',')
            .map((entry) => entry.trim())
            .filter(Boolean);
      return list.some((entry) => compareEquals(value, entry));
    }
    default:
      return false;
  }
}

function compareEquals(left: unknown, right: unknown): boolean {
  if (left === null || left === undefined) return right === 'null' || right === null;
  if (typeof left === 'boolean' || typeof right === 'boolean') {
    return asText(left).toLowerCase() === asText(right).toLowerCase();
  }
  const leftNumber = asNumber(left);
  const rightNumber = asNumber(right);
  if (leftNumber !== null && rightNumber !== null && typeof right !== 'string') {
    return leftNumber === rightNumber;
  }
  return asText(left).trim().toLowerCase() === asText(right).trim().toLowerCase();
}

/**
 * Decides what a workflow would do for a given document.
 *
 * The trigger and the document type are checked before the conditions: a workflow that is not
 * triggered has no opinion, and saying so is what makes the run log readable.
 */
export function planWorkflow(
  workflow: WorkflowDefinition,
  context: ConditionContext,
): WorkflowPlan {
  const base: WorkflowPlan = {
    workflowId: workflow.id,
    matched: false,
    explanation: '',
    actions: [],
    needsApproval: false,
  };

  if (!workflow.enabled) {
    return { ...base, explanation: 'Workflow is disabled.' };
  }
  if (workflow.trigger !== context.trigger) {
    return { ...base, explanation: `Triggered by ${context.trigger}, not ${workflow.trigger}.` };
  }
  if (workflow.documentType && workflow.documentType !== context.documentType) {
    return {
      ...base,
      explanation: `Applies to ${workflow.documentType}; this record is ${context.documentType ?? 'unknown'}.`,
    };
  }

  const failed = workflow.conditions.find((condition) => !evaluateCondition(condition, context));
  if (failed) {
    return {
      ...base,
      explanation: `Condition not met: ${describeCondition(failed)}.`,
    };
  }

  const actions: PlannedAction[] = workflow.actions.map((action) => {
    const destructive = DESTRUCTIVE_ACTIONS.includes(action.type);
    const requiresApproval = destructive && workflow.approvalPolicy !== 'auto_approve';
    return {
      type: action.type,
      config: action.config ?? {},
      destructive,
      requiresApproval,
      reason: requiresApproval ? approvalReason(action.type) : null,
    };
  });

  return {
    workflowId: workflow.id,
    matched: true,
    explanation:
      workflow.conditions.length === 0
        ? 'Matched every record of this type.'
        : `Matched ${workflow.conditions.length} condition(s).`,
    actions,
    needsApproval: actions.some((action) => action.requiresApproval),
  };
}

function describeCondition(condition: WorkflowCondition): string {
  const value = Array.isArray(condition.value) ? condition.value.join(', ') : condition.value;
  return condition.operator === 'exists'
    ? `${condition.field} is missing`
    : `${condition.field} ${condition.operator.replace(/_/g, ' ')} ${value ?? ''}`.trim();
}

function approvalReason(type: WorkflowActionType): string {
  switch (type) {
    case 'send_to_connector':
      return 'Writes to an external system, so a person approves it first.';
    case 'create_export':
      return 'Produces a file with document data in it, so a person approves it first.';
    case 'delete_document':
      return 'Deletes a document, so a person approves it first.';
    default:
      return 'Requires approval.';
  }
}

/** Validates a definition before it is stored, so a broken rule never reaches the worker. */
export function validateWorkflow(definition: {
  name: string;
  trigger: string;
  actions: Array<{ type: string }>;
  conditions: Array<{ field: string; operator: string }>;
}): string[] {
  const problems: string[] = [];
  if (!definition.name.trim()) problems.push('Give the workflow a name.');
  if (!(WORKFLOW_TRIGGERS as readonly string[]).includes(definition.trigger)) {
    problems.push(`Trigger must be one of: ${WORKFLOW_TRIGGERS.join(', ')}.`);
  }
  if (definition.actions.length === 0) problems.push('A workflow needs at least one action.');
  for (const action of definition.actions) {
    if (!(WORKFLOW_ACTIONS as readonly string[]).includes(action.type)) {
      problems.push(`Unknown action "${action.type}".`);
    }
  }
  for (const condition of definition.conditions) {
    if (!condition.field.trim()) problems.push('Every condition needs a field.');
    if (!(CONDITION_OPERATORS as readonly string[]).includes(condition.operator)) {
      problems.push(`Unknown operator "${condition.operator}".`);
    }
  }
  return problems;
}
