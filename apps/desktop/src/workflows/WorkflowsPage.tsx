import React, { useState } from 'react';
import { DOCUMENT_TYPES } from '@idcp/shared';
import type { ApiClient, WorkflowDefinition, WorkflowRun } from '../api/client';
import { formatDateTime } from '../lib/format';
import { Badge, Card, EmptyState, ErrorBanner, Field, useAsync } from '../components/ui';

/**
 * The workflow builder (AGENT-001).
 *
 * It is a form rather than a canvas, and deliberately so: every rule is "when this happens, if these
 * hold, do that", which is a sentence a person can read back. The builder shows that sentence while
 * it is being written, names which actions will wait for a human, and lists every run with its
 * decision — including the runs that decided not to act.
 */

export const WORKFLOW_TRIGGERS = [
  'document.approved',
  'document.extracted',
  'document.needs_review',
  'batch.completed',
] as const;

export const WORKFLOW_ACTIONS = [
  'notify',
  'send_to_connector',
  'create_export',
  'delete_document',
] as const;

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

export const DESTRUCTIVE_ACTIONS = ['send_to_connector', 'create_export', 'delete_document'];

export function actionLabel(action: string): string {
  switch (action) {
    case 'notify':
      return 'Send a notification';
    case 'send_to_connector':
      return 'Send the record to a connector';
    case 'create_export':
      return 'Create an export';
    case 'delete_document':
      return 'Delete the document';
    default:
      return action;
  }
}

export function triggerLabel(trigger: string): string {
  return trigger.replace('document.', 'Document ').replace('batch.', 'Batch ');
}

/** The rule as one sentence, so it can be checked before it is saved. */
export function describeRule(rule: {
  trigger: string;
  documentType?: string | null;
  conditions: Array<{ field: string; operator: string; value?: unknown }>;
  actions: Array<{ type: string }>;
  approvalPolicy: string;
}): string {
  const when = `When a ${rule.documentType ?? 'record'} is ${triggerLabel(rule.trigger).toLowerCase()}`;
  const conditions =
    rule.conditions.length === 0
      ? ''
      : `, if ${rule.conditions
          .map((condition) =>
            condition.operator === 'exists'
              ? `${condition.field} is present`
              : `${condition.field} ${condition.operator.replace(/_/g, ' ')} ${String(
                  condition.value ?? '',
                )}`.trim(),
          )
          .join(' and ')}`;
  const actions = rule.actions
    .map((action) => actionLabel(action.type).toLowerCase())
    .join(', then ');
  const gate =
    rule.approvalPolicy === 'auto_approve'
      ? ' (runs without approval)'
      : rule.actions.some((action) => DESTRUCTIVE_ACTIONS.includes(action.type))
        ? ' (a person approves the destructive steps)'
        : '';
  return `${when}${conditions}, ${actions}${gate}.`;
}

const emptyCondition = { field: '', operator: 'equals' as string, value: '' };

export function WorkflowsPage({ client }: { client: ApiClient }): React.JSX.Element {
  const workflows = useAsync(() => client.listWorkflows(), []);
  const runs = useAsync(() => client.workflowRuns(25), []);

  const [name, setName] = useState('');
  const [trigger, setTrigger] = useState<string>('document.approved');
  const [documentType, setDocumentType] = useState('');
  const [conditions, setConditions] = useState([{ ...emptyCondition }]);
  const [actions, setActions] = useState<string[]>(['notify']);
  const [approvalPolicy, setApprovalPolicy] = useState<'always_ask' | 'auto_approve'>('always_ask');
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const draft = {
    trigger,
    documentType: documentType || null,
    conditions: conditions.filter((condition) => condition.field.trim() !== ''),
    actions: actions.map((type) => ({ type })),
    approvalPolicy,
  };

  const save = async () => {
    setError(null);
    setNotice(null);
    setBusy(true);
    try {
      await client.createWorkflow({
        name: name.trim(),
        ...draft,
      });
      setNotice('Workflow saved.');
      setName('');
      setConditions([{ ...emptyCondition }]);
      setActions(['notify']);
      await workflows.reload();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not save that workflow.');
    } finally {
      setBusy(false);
    }
  };

  const toggle = async (workflow: WorkflowDefinition) => {
    setError(null);
    try {
      await client.setWorkflowEnabled(workflow.id, !workflow.enabled);
      await workflows.reload();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not change that workflow.');
    }
  };

  const approve = async (run: WorkflowRun) => {
    setError(null);
    try {
      const result = await client.approveWorkflowRun(run.id);
      setNotice(`Approved: ${result.outputs.join(' · ') || 'nothing to do'}`);
      await runs.reload();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not approve that run.');
    }
  };

  const items = workflows.data?.items ?? [];
  const pending = (runs.data?.items ?? []).filter((run) => run.status === 'awaiting_approval');

  return (
    <div className="stack">
      <h1>Workflows</h1>

      <ErrorBanner message={error ?? workflows.error} />
      {notice && (
        <div className="notice" role="status">
          {notice}
        </div>
      )}

      {pending.length > 0 && (
        <Card title={`Waiting for approval (${pending.length})`}>
          <div className="stack">
            {pending.map((run) => (
              <div key={run.id} className="row" style={{ justifyContent: 'space-between' }}>
                <div>
                  <div>{run.explanation}</div>
                  <div className="dim">
                    {run.actions.map((action) => actionLabel(action.type)).join(' · ')} ·{' '}
                    {formatDateTime(run.createdAt)}
                  </div>
                </div>
                <button className="button small" type="button" onClick={() => void approve(run)}>
                  Approve run
                </button>
              </div>
            ))}
          </div>
        </Card>
      )}

      <Card title="New workflow">
        <div className="stack">
          <div className="row" style={{ gap: 12, flexWrap: 'wrap' }}>
            <Field label="Name">
              <input
                className="input"
                value={name}
                placeholder="File large invoices"
                onChange={(event) => setName(event.target.value)}
              />
            </Field>
            <Field label="When">
              <select
                className="select"
                value={trigger}
                onChange={(event) => setTrigger(event.target.value)}
              >
                {WORKFLOW_TRIGGERS.map((option) => (
                  <option key={option} value={option}>
                    {triggerLabel(option)}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Document type">
              <select
                className="select"
                value={documentType}
                onChange={(event) => setDocumentType(event.target.value)}
              >
                <option value="">Any type</option>
                {DOCUMENT_TYPES.map((type) => (
                  <option key={type} value={type}>
                    {type}
                  </option>
                ))}
              </select>
            </Field>
            <Field
              label="Approval"
              hint="Destructive steps wait for a person unless you choose otherwise."
            >
              <select
                className="select"
                value={approvalPolicy}
                onChange={(event) =>
                  setApprovalPolicy(event.target.value as 'always_ask' | 'auto_approve')
                }
              >
                <option value="always_ask">Ask me first</option>
                <option value="auto_approve">Run without asking</option>
              </select>
            </Field>
          </div>

          <div>
            <div className="label">If</div>
            {conditions.map((condition, index) => (
              <div key={index} className="row" style={{ gap: 8, marginBottom: 6 }}>
                <input
                  className="input"
                  aria-label={`Condition ${index + 1} field`}
                  placeholder="total.amount"
                  value={condition.field}
                  onChange={(event) => {
                    const next = [...conditions];
                    next[index] = { ...condition, field: event.target.value };
                    setConditions(next);
                  }}
                />
                <select
                  className="select"
                  aria-label={`Condition ${index + 1} operator`}
                  value={condition.operator}
                  onChange={(event) => {
                    const next = [...conditions];
                    next[index] = { ...condition, operator: event.target.value };
                    setConditions(next);
                  }}
                >
                  {CONDITION_OPERATORS.map((operator) => (
                    <option key={operator} value={operator}>
                      {operator.replace(/_/g, ' ')}
                    </option>
                  ))}
                </select>
                <input
                  className="input"
                  aria-label={`Condition ${index + 1} value`}
                  placeholder="100"
                  value={String(condition.value ?? '')}
                  onChange={(event) => {
                    const next = [...conditions];
                    next[index] = { ...condition, value: event.target.value };
                    setConditions(next);
                  }}
                />
                <button
                  className="button secondary small"
                  type="button"
                  onClick={() => setConditions(conditions.filter((_, at) => at !== index))}
                >
                  Remove
                </button>
              </div>
            ))}
            <button
              className="button secondary small"
              type="button"
              onClick={() => setConditions([...conditions, { ...emptyCondition }])}
            >
              Add condition
            </button>
          </div>

          <div>
            <div className="label">Then</div>
            {WORKFLOW_ACTIONS.map((action) => (
              <label key={action} className="row" style={{ gap: 8 }}>
                <input
                  type="checkbox"
                  checked={actions.includes(action)}
                  onChange={(event) =>
                    setActions(
                      event.target.checked
                        ? [...actions, action]
                        : actions.filter((entry) => entry !== action),
                    )
                  }
                />
                <span>{actionLabel(action)}</span>
                {DESTRUCTIVE_ACTIONS.includes(action) && <Badge tone="warning">approval</Badge>}
              </label>
            ))}
          </div>

          <p className="dim" style={{ margin: 0 }} role="note">
            {describeRule(draft)}
          </p>

          <div>
            <button
              className="button"
              type="button"
              disabled={busy || name.trim() === '' || actions.length === 0}
              onClick={() => void save()}
            >
              Save workflow
            </button>
          </div>
        </div>
      </Card>

      <Card title={`Rules (${items.length})`}>
        {items.length === 0 ? (
          <EmptyState title="No workflows yet" hint="Build one above; it takes a minute." />
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>Rule</th>
                <th>Reads as</th>
                <th>State</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {items.map((workflow) => (
                <tr key={workflow.id}>
                  <td>{workflow.name}</td>
                  <td className="dim">{describeRule(workflow)}</td>
                  <td>
                    <Badge tone={workflow.enabled ? 'success' : 'neutral'}>
                      {workflow.enabled ? 'enabled' : 'paused'}
                    </Badge>
                  </td>
                  <td style={{ textAlign: 'right' }}>
                    <button
                      className="button secondary small"
                      type="button"
                      onClick={() => void toggle(workflow)}
                    >
                      {workflow.enabled ? 'Pause' : 'Enable'}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>

      <Card title="Run log">
        {(runs.data?.items.length ?? 0) === 0 ? (
          <EmptyState
            title="Nothing has run yet"
            hint="Runs are recorded when a workflow is evaluated, including the ones that skip."
          />
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>When</th>
                <th>Outcome</th>
                <th>Why</th>
                <th>Did</th>
              </tr>
            </thead>
            <tbody>
              {runs.data!.items.map((run) => (
                <tr key={run.id}>
                  <td className="dim">{formatDateTime(run.createdAt)}</td>
                  <td>
                    <Badge
                      tone={
                        run.status === 'failed'
                          ? 'danger'
                          : run.status === 'awaiting_approval'
                            ? 'warning'
                            : run.status === 'completed'
                              ? 'success'
                              : 'neutral'
                      }
                    >
                      {run.status.replace(/_/g, ' ')}
                    </Badge>
                  </td>
                  <td>{run.explanation}</td>
                  <td className="dim">
                    {run.outputs.length > 0 ? run.outputs.join(' · ') : (run.failure ?? '—')}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
    </div>
  );
}
