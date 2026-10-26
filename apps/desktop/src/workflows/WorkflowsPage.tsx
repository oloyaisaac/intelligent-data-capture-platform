import React, { useState } from 'react';
import { DOCUMENT_TYPES } from '@idcp/shared';
import type { Translate, TranslationKey } from '@idcp/shared';
import type { ApiClient, WorkflowDefinition, WorkflowRun } from '../api/client';
import { formatDateTime } from '../lib/format';
import { useLocale, useTranslator } from '../lib/locale';
import { documentTypeLabel } from '../lib/labels';
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

const ACTION_KEYS: Record<string, TranslationKey> = {
  notify: 'workflow.action.notify',
  send_to_connector: 'workflow.action.sendToConnector',
  create_export: 'workflow.action.createExport',
  delete_document: 'workflow.action.deleteDocument',
};

const TRIGGER_KEYS: Record<string, TranslationKey> = {
  'document.approved': 'workflow.trigger.documentApproved',
  'document.extracted': 'workflow.trigger.documentExtracted',
  'document.needs_review': 'workflow.trigger.documentNeedsReview',
  'batch.completed': 'workflow.trigger.batchCompleted',
};

/**
 * I18N-001 — the rule's sentence is assembled from translated fragments rather than English words.
 *
 * Each helper takes an optional translator; without one it speaks English, so the pure description
 * stays testable on its own (and the desktop test asserts that exact sentence).
 */
export function actionLabel(action: string, t?: Translate): string {
  const key = ACTION_KEYS[action];
  if (t && key) return t(key);
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

export function triggerLabel(trigger: string, t?: Translate): string {
  const key = TRIGGER_KEYS[trigger];
  if (t && key) return t(key);
  return trigger.replace('document.', 'Document ').replace('batch.', 'Batch ');
}

export function runStatusLabel(status: string, t?: Translate): string {
  const keys: Record<string, TranslationKey> = {
    matched: 'workflow.status.matched',
    skipped: 'workflow.status.skipped',
    awaiting_approval: 'workflow.status.awaitingApproval',
    completed: 'workflow.status.completed',
    failed: 'workflow.status.failed',
  };
  const key = keys[status];
  if (t && key) return t(key);
  return status.replace(/_/g, ' ');
}

/**
 * The rule as one sentence, so it can be checked before it is saved.
 *
 * With a translator the sentence is assembled from translated fragments; without one it stays
 * English, which is what the pure unit test asserts.
 */
export function describeRule(
  rule: {
    trigger: string;
    documentType?: string | null;
    conditions: Array<{ field: string; operator: string; value?: unknown }>;
    actions: Array<{ type: string }>;
    approvalPolicy: string;
  },
  t?: Translate,
): string {
  const start = t
    ? t('workflow.sentence.start', {
        type: rule.documentType ?? 'record',
        trigger: triggerLabel(rule.trigger, t).toLowerCase(),
      })
    : `When a ${rule.documentType ?? 'record'} is ${triggerLabel(rule.trigger).toLowerCase()}`;

  const conditionText = (condition: { field: string; operator: string; value?: unknown }) =>
    condition.operator === 'exists'
      ? t
        ? t('workflow.sentence.exists', { field: condition.field })
        : `${condition.field} is present`
      : t
        ? t('workflow.sentence.condition', {
            field: condition.field,
            operator: condition.operator.replace(/_/g, ' '),
            value: String(condition.value ?? ''),
          }).trim()
        : `${condition.field} ${condition.operator.replace(/_/g, ' ')} ${String(
            condition.value ?? '',
          )}`.trim();

  const joinAnd = t ? t('workflow.sentence.and') : ' and ';
  const conditional =
    rule.conditions.length === 0
      ? ''
      : t
        ? t('workflow.sentence.if', {
            conditions: rule.conditions.map(conditionText).join(joinAnd),
          })
        : `, if ${rule.conditions.map(conditionText).join(joinAnd)}`;

  const joinThen = t ? t('workflow.sentence.joinThen') : ', then ';
  const actions = rule.actions
    .map((action) => actionLabel(action.type, t).toLowerCase())
    .join(joinThen);

  const destructive = rule.actions.some((action) => DESTRUCTIVE_ACTIONS.includes(action.type));
  const gate = t
    ? rule.approvalPolicy === 'auto_approve'
      ? t('workflow.sentence.gateAuto')
      : destructive
        ? t('workflow.sentence.gateApproval')
        : ''
    : rule.approvalPolicy === 'auto_approve'
      ? ' (runs without approval)'
      : destructive
        ? ' (a person approves the destructive steps)'
        : '';

  if (!t) return `${start}${conditional}, ${actions}${gate}.`;
  return t('workflow.sentence.full', {
    start,
    conditional,
    actions,
    gate,
  });
}

const emptyCondition = { field: '', operator: 'equals' as string, value: '' };

export function WorkflowsPage({ client }: { client: ApiClient }): React.JSX.Element {
  const t = useTranslator();
  const { locale } = useLocale();
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
      setNotice(t('workflow.saved'));
      setName('');
      setConditions([{ ...emptyCondition }]);
      setActions(['notify']);
      await workflows.reload();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : t('workflow.saveFailed'));
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
      setError(caught instanceof Error ? caught.message : t('workflow.changeFailed'));
    }
  };

  const approve = async (run: WorkflowRun) => {
    setError(null);
    try {
      const result = await client.approveWorkflowRun(run.id);
      setNotice(
        t('workflow.approvedNotice', {
          outputs: result.outputs.join(' · ') || t('workflow.nothingToDo'),
        }),
      );
      await runs.reload();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : t('workflow.approveFailed'));
    }
  };

  const items = workflows.data?.items ?? [];
  const pending = (runs.data?.items ?? []).filter((run) => run.status === 'awaiting_approval');

  return (
    <div className="stack">
      <h1>{t('workflow.title')}</h1>

      <ErrorBanner message={error ?? workflows.error} />
      {notice && (
        <div className="notice" role="status">
          {notice}
        </div>
      )}

      {pending.length > 0 && (
        <Card title={t('workflow.waitingApproval', { count: pending.length })}>
          <div className="stack">
            {pending.map((run) => (
              <div key={run.id} className="row" style={{ justifyContent: 'space-between' }}>
                <div>
                  <div>{run.explanation}</div>
                  <div className="dim">
                    {run.actions.map((action) => actionLabel(action.type, t)).join(' · ')} ·{' '}
                    {formatDateTime(run.createdAt, locale)}
                  </div>
                </div>
                <button className="button small" type="button" onClick={() => void approve(run)}>
                  {t('workflow.approveRun')}
                </button>
              </div>
            ))}
          </div>
        </Card>
      )}

      <Card title={t('workflow.new')}>
        <div className="stack">
          <div className="row" style={{ gap: 12, flexWrap: 'wrap' }}>
            <Field label={t('workflow.name')}>
              <input
                className="input"
                value={name}
                placeholder={t('workflow.namePlaceholder')}
                onChange={(event) => setName(event.target.value)}
              />
            </Field>
            <Field label={t('workflow.when')}>
              <select
                className="select"
                value={trigger}
                onChange={(event) => setTrigger(event.target.value)}
              >
                {WORKFLOW_TRIGGERS.map((option) => (
                  <option key={option} value={option}>
                    {triggerLabel(option, t)}
                  </option>
                ))}
              </select>
            </Field>
            <Field label={t('filter.documentType')}>
              <select
                className="select"
                value={documentType}
                onChange={(event) => setDocumentType(event.target.value)}
              >
                <option value="">{t('workflow.anyType')}</option>
                {DOCUMENT_TYPES.map((type) => (
                  <option key={type} value={type}>
                    {documentTypeLabel(t, type)}
                  </option>
                ))}
              </select>
            </Field>
            <Field label={t('workflow.approval')} hint={t('workflow.approvalHint')}>
              <select
                className="select"
                value={approvalPolicy}
                onChange={(event) =>
                  setApprovalPolicy(event.target.value as 'always_ask' | 'auto_approve')
                }
              >
                <option value="always_ask">{t('workflow.askFirst')}</option>
                <option value="auto_approve">{t('workflow.autoApprove')}</option>
              </select>
            </Field>
          </div>

          <div>
            <div className="label">{t('workflow.if')}</div>
            {conditions.map((condition, index) => (
              <div key={index} className="row" style={{ gap: 8, marginBottom: 6 }}>
                <input
                  className="input"
                  aria-label={t('workflow.conditionField', { index: index + 1 })}
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
                  aria-label={t('workflow.conditionOperator', { index: index + 1 })}
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
                  aria-label={t('workflow.conditionValue', { index: index + 1 })}
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
                  {t('workflow.remove')}
                </button>
              </div>
            ))}
            <button
              className="button secondary small"
              type="button"
              onClick={() => setConditions([...conditions, { ...emptyCondition }])}
            >
              {t('workflow.addCondition')}
            </button>
          </div>

          <div>
            <div className="label">{t('workflow.then')}</div>
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
                <span>{actionLabel(action, t)}</span>
                {DESTRUCTIVE_ACTIONS.includes(action) && (
                  <Badge tone="warning">{t('workflow.approvalBadge')}</Badge>
                )}
              </label>
            ))}
          </div>

          <p className="dim" style={{ margin: 0 }} role="note">
            {describeRule(draft, t)}
          </p>

          <div>
            <button
              className="button"
              type="button"
              disabled={busy || name.trim() === '' || actions.length === 0}
              onClick={() => void save()}
            >
              {t('workflow.save')}
            </button>
          </div>
        </div>
      </Card>

      <Card title={t('workflow.rules', { count: items.length })}>
        {items.length === 0 ? (
          <EmptyState title={t('workflow.none')} hint={t('workflow.noneHint')} />
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>{t('workflow.rule')}</th>
                <th>{t('workflow.readsAs')}</th>
                <th>{t('workflow.state')}</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {items.map((workflow) => (
                <tr key={workflow.id}>
                  <td>{workflow.name}</td>
                  <td className="dim">{describeRule(workflow, t)}</td>
                  <td>
                    <Badge tone={workflow.enabled ? 'success' : 'neutral'}>
                      {workflow.enabled ? t('workflow.enabled') : t('workflow.paused')}
                    </Badge>
                  </td>
                  <td style={{ textAlign: 'end' }}>
                    <button
                      className="button secondary small"
                      type="button"
                      onClick={() => void toggle(workflow)}
                    >
                      {workflow.enabled ? t('workflow.pause') : t('workflow.enable')}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>

      <Card title={t('workflow.runLog')}>
        {(runs.data?.items.length ?? 0) === 0 ? (
          <EmptyState title={t('workflow.noRuns')} hint={t('workflow.noRunsHint')} />
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>{t('table.when')}</th>
                <th>{t('table.outcome')}</th>
                <th>{t('table.why')}</th>
                <th>{t('table.did')}</th>
              </tr>
            </thead>
            <tbody>
              {runs.data!.items.map((run) => (
                <tr key={run.id}>
                  <td className="dim">{formatDateTime(run.createdAt, locale)}</td>
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
                      {runStatusLabel(run.status, t)}
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
