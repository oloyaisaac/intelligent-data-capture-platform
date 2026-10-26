import React, { useState } from 'react';
import { DOCUMENT_TYPES, type Template, type TemplateDetail } from '@idcp/shared';
import type { ApiClient } from '../api/client';
import { formatDateTime, titleCase } from '../lib/format';
import { Badge, Card, EmptyState, ErrorBanner, Field, Modal, useAsync } from '../components/ui';
import { useLocale, useTranslator } from '../lib/locale';
import { documentTypeLabel } from '../lib/labels';

interface DraftField {
  path: string;
  label: string;
  type: 'string' | 'number' | 'currency' | 'date' | 'boolean';
  required: boolean;
}

/**
 * TPL-001 — the template builder.
 *
 * A template can be started from a processed document (its fields become the template) or from
 * scratch. Saving a changed field list creates a new version; disabling keeps every version.
 */
export function TemplatesPage({ client }: { client: ApiClient }): React.JSX.Element {
  const t = useTranslator();
  const { locale } = useLocale();
  const templates = useAsync(() => client.listTemplates(), []);
  const [editing, setEditing] = useState<TemplateDetail | null>(null);
  const [detail, setDetail] = useState<TemplateDetail | null>(null);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [documentType, setDocumentType] = useState<string>('invoice');
  const [fromDocumentId, setFromDocumentId] = useState('');
  const [draft, setDraft] = useState<DraftField[]>([
    { path: '', label: '', type: 'string', required: false },
  ]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const startCreate = () => {
    setCreating(true);
    setEditing(null);
    setName('');
    setDocumentType('invoice');
    setFromDocumentId('');
    setDraft([{ path: '', label: '', type: 'string', required: false }]);
    setError(null);
  };

  const startEdit = async (template: Template) => {
    setError(null);
    setCreating(false);
    try {
      const full = await client.getTemplate(template.id);
      setEditing(full);
      setName(full.name);
      setDraft(
        full.fields.map((field) => ({
          path: field.path,
          label: field.label,
          type: field.type,
          required: field.required,
        })),
      );
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : t('templates.openFailed'));
    }
  };

  const save = async () => {
    const fields = draft
      .filter((field) => field.path.trim() && field.label.trim())
      .map((field) => ({
        path: field.path.trim(),
        label: field.label.trim(),
        type: field.type,
        required: field.required,
      }));

    if (fields.length === 0 && !fromDocumentId) {
      setError(t('templates.needsField'));
      return;
    }

    setBusy(true);
    setError(null);
    try {
      if (editing) {
        setDetail(await client.updateTemplate(editing.id, { name, fields }));
      } else {
        const created = await client.createTemplate({
          name,
          documentType: documentType as (typeof DOCUMENT_TYPES)[number],
          fields,
          ...(fromDocumentId ? { fromDocumentId } : {}),
        });
        setDetail(created);
      }
      setCreating(false);
      setEditing(null);
      await templates.reload();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : t('templates.saveFailed'));
    } finally {
      setBusy(false);
    }
  };

  const isOpen = creating || editing !== null;

  return (
    <div className="stack">
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <h1>{t('templates.title')}</h1>
        <button className="button" type="button" onClick={startCreate}>
          {t('templates.new')}
        </button>
      </div>

      <ErrorBanner message={error ?? templates.error} />

      <Card title={t('templates.card')}>
        {templates.data && templates.data.items.length > 0 ? (
          <table className="table">
            <thead>
              <tr>
                <th>{t('connectors.name')}</th>
                <th>{t('filter.documentType')}</th>
                <th>{t('table.fields')}</th>
                <th>{t('table.version')}</th>
                <th>{t('table.status')}</th>
                <th>{t('table.updated')}</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {templates.data.items.map((template) => (
                <tr key={template.id}>
                  <td>{template.name}</td>
                  <td>{documentTypeLabel(t, template.documentType)}</td>
                  <td>{template.fields.length}</td>
                  <td className="mono">v{template.version}</td>
                  <td>
                    <Badge tone={template.active ? 'success' : 'neutral'}>
                      {template.active ? t('status.active') : t('templates.disabled')}
                    </Badge>
                  </td>
                  <td className="dim">{formatDateTime(template.updatedAt)}</td>
                  <td>
                    <div className="row" style={{ justifyContent: 'flex-end' }}>
                      <button
                        className="button secondary small"
                        type="button"
                        onClick={() => void startEdit(template)}
                      >
                        Edit
                      </button>
                      <button
                        className="button secondary small"
                        type="button"
                        onClick={async () => {
                          try {
                            await client.updateTemplate(template.id, { active: !template.active });
                            await templates.reload();
                          } catch (caught) {
                            setError(
                              caught instanceof Error
                                ? caught.message
                                : t('templates.couldNotChange'),
                            );
                          }
                        }}
                      >
                        {template.active ? t('templates.disable') : t('templates.enable')}
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <EmptyState title={t('templates.none')} hint={t('templates.noneHint')} />
        )}
      </Card>

      {detail && (
        <Card title={t('templates.versionsFor', { name: detail.name })}>
          <table className="table">
            <thead>
              <tr>
                <th>{t('table.version')}</th>
                <th>{t('table.fields')}</th>
                <th>{t('table.created')}</th>
              </tr>
            </thead>
            <tbody>
              {detail.versions.map((version) => (
                <tr key={version.version}>
                  <td className="mono">v{version.version}</td>
                  <td>{version.fields.map((field) => field.label).join(', ')}</td>
                  <td className="dim">{formatDateTime(version.createdAt, locale)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}

      {isOpen && (
        <Modal
          title={editing ? t('templates.edit', { name: editing.name }) : t('templates.new')}
          onClose={() => {
            setCreating(false);
            setEditing(null);
          }}
          footer={
            <>
              <button
                className="button secondary"
                type="button"
                onClick={() => {
                  setCreating(false);
                  setEditing(null);
                }}
              >
                {t('action.cancel')}
              </button>
              <button
                className="button"
                type="button"
                onClick={() => void save()}
                disabled={busy || name.trim().length === 0}
              >
                {busy ? t('templates.saving') : t('templates.save')}
              </button>
            </>
          }
        >
          <Field label={t('connectors.name')}>
            <input
              className="input"
              value={name}
              onChange={(event) => setName(event.target.value)}
            />
          </Field>

          {!editing && (
            <>
              <Field label={t('filter.documentType')}>
                <select
                  className="select"
                  value={documentType}
                  onChange={(event) => setDocumentType(event.target.value)}
                >
                  {DOCUMENT_TYPES.map((type) => (
                    <option key={type} value={type}>
                      {titleCase(type)}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label={t('templates.baseOnDocument')} hint={t('templates.baseOnDocumentHint')}>
                <input
                  className="input mono"
                  value={fromDocumentId}
                  placeholder={t('templates.documentPlaceholder')}
                  onChange={(event) => setFromDocumentId(event.target.value.trim())}
                />
              </Field>
            </>
          )}

          <div className="stack">
            <span className="label">{t('table.fields')}</span>
            {draft.map((field, index) => (
              <div className="row" key={index} style={{ alignItems: 'flex-end' }}>
                <Field label={t('table.path')}>
                  <input
                    className="input mono"
                    value={field.path}
                    placeholder={t('templates.pathPlaceholder')}
                    onChange={(event) => {
                      const next = [...draft];
                      next[index] = { ...field, path: event.target.value };
                      setDraft(next);
                    }}
                  />
                </Field>
                <Field label={t('table.label')}>
                  <input
                    className="input"
                    value={field.label}
                    placeholder={t('templates.labelPlaceholder')}
                    onChange={(event) => {
                      const next = [...draft];
                      next[index] = { ...field, label: event.target.value };
                      setDraft(next);
                    }}
                  />
                </Field>
                <Field label={t('table.type')}>
                  <select
                    className="select"
                    value={field.type}
                    onChange={(event) => {
                      const next = [...draft];
                      next[index] = { ...field, type: event.target.value as DraftField['type'] };
                      setDraft(next);
                    }}
                  >
                    {['string', 'number', 'currency', 'date', 'boolean'].map((type) => (
                      <option key={type} value={type}>
                        {type}
                      </option>
                    ))}
                  </select>
                </Field>
                <label className="row" style={{ gap: 6 }}>
                  <input
                    type="checkbox"
                    checked={field.required}
                    onChange={(event) => {
                      const next = [...draft];
                      next[index] = { ...field, required: event.target.checked };
                      setDraft(next);
                    }}
                  />
                  <span className="dim">{t('templates.required')}</span>
                </label>
                <button
                  className="button secondary small"
                  type="button"
                  aria-label={t('templates.removeField')}
                  onClick={() => setDraft(draft.filter((_, position) => position !== index))}
                >
                  ×
                </button>
              </div>
            ))}
            <button
              className="button secondary small"
              type="button"
              onClick={() =>
                setDraft([...draft, { path: '', label: '', type: 'string', required: false }])
              }
            >
              {t('templates.addField')}
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}
