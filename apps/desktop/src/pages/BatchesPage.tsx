import React, { useState } from 'react';
import { DOCUMENT_TYPES, type BatchSummary } from '@idcp/shared';
import type { ApiClient } from '../api/client';
import { formatDateTime, statusTone } from '../lib/format';
import { Badge, Card, EmptyState, ErrorBanner, Field, useAsync, useTick } from '../components/ui';
import { documentTypeLabel, statusLabel } from '../lib/labels';
import { useLocale, useTranslator } from '../lib/locale';

/**
 * BATCH-001 — batch upload on the desktop.
 *
 * Files are chosen once and uploaded in a single request. The list then polls while anything is
 * still processing, because progress lives on the server (derived from the documents) and a second
 * source of truth in the UI would drift.
 */
export function BatchesPage({ client }: { client: ApiClient }): React.JSX.Element {
  const t = useTranslator();
  const { locale } = useLocale();
  const batches = useAsync(() => client.listBatches(20), []);
  const projects = useAsync(() => client.listProjects(), []);
  const tick = useTick(5_000);

  const [files, setFiles] = useState<File[]>([]);
  const [name, setName] = useState('');
  const [projectId, setProjectId] = useState('');
  const [documentType, setDocumentType] = useState('');
  const [selected, setSelected] = useState<BatchSummary | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const items = batches.data?.items ?? [];
  const processing = items.some((batch) => batch.status === 'processing');

  // Re-read while work is in flight; the interval is owned by the shared tick hook.
  React.useEffect(() => {
    if (processing && tick > 0) void batches.reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tick]);

  const upload = async () => {
    if (files.length === 0) return;
    setBusy(true);
    setError(null);
    try {
      const batch = await client.createBatch({
        files,
        ...(name.trim() ? { name: name.trim() } : {}),
        ...(projectId ? { projectId } : {}),
        ...(documentType ? { documentType } : {}),
      });
      setSelected(batch);
      setFiles([]);
      setName('');
      await batches.reload();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : t('batches.uploadFailed'));
    } finally {
      setBusy(false);
    }
  };

  const download = async (batch: BatchSummary) => {
    try {
      const { blob, filename } = await client.downloadBatchResults(batch.id);
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = filename;
      link.click();
      URL.revokeObjectURL(url);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : t('batches.downloadFailed'));
    }
  };

  const open = async (batch: BatchSummary) => {
    try {
      setSelected(await client.getBatch(batch.id));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : t('batches.openFailed'));
    }
  };

  return (
    <div className="stack">
      <h1>{t('batches.title')}</h1>
      <ErrorBanner message={error ?? batches.error} />

      <Card title={t('batches.uploadCard')}>
        <div className="stack">
          <p className="muted">
            Every file becomes its own document. A file that cannot be read is reported next to the
            others instead of failing the whole batch.
          </p>
          <input
            type="file"
            multiple
            accept="image/jpeg,image/png,image/heic,application/pdf"
            onChange={(event) => setFiles(Array.from(event.target.files ?? []))}
            aria-label={t('batches.chooseFiles')}
          />
          {files.length > 0 && <p className="dim">{files.length} file(s) selected</p>}

          <div className="row">
            <Field label={t('batches.name')}>
              <input
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder={t('batches.namePlaceholder')}
                maxLength={120}
              />
            </Field>
            <Field label={t('batches.project')}>
              <select value={projectId} onChange={(event) => setProjectId(event.target.value)}>
                <option value="">{t('batches.noProject')}</option>
                {(projects.data?.items ?? []).map((project) => (
                  <option key={project.id} value={project.id}>
                    {project.name}
                  </option>
                ))}
              </select>
            </Field>
            <Field label={t('filter.documentType')} hint={t('batches.documentTypeHint')}>
              <select
                value={documentType}
                onChange={(event) => setDocumentType(event.target.value)}
              >
                <option value="">{t('batches.detectAutomatically')}</option>
                {DOCUMENT_TYPES.map((type) => (
                  <option key={type} value={type}>
                    {type.replace(/_/g, ' ')}
                  </option>
                ))}
              </select>
            </Field>
          </div>

          <div className="row">
            <button
              className="button"
              type="button"
              onClick={() => void upload()}
              disabled={busy || files.length === 0}
            >
              {busy
                ? t('batches.uploading')
                : t('batches.uploadCount', { count: files.length || '' })}
            </button>
            <span className="dim">{t('batches.limit')}</span>
          </div>
        </div>
      </Card>

      <div className="grid two">
        <Card title={t('batches.recent')}>
          {items.length === 0 ? (
            <EmptyState title={t('batches.none')} hint={t('batches.noneHint')} />
          ) : (
            <table className="table">
              <thead>
                <tr>
                  <th>{t('settings.name')}</th>
                  <th>{t('table.progress')}</th>
                  <th>{t('table.status')}</th>
                  <th>{t('table.created')}</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {items.map((batch) => (
                  <tr key={batch.id}>
                    <td>{batch.name}</td>
                    <td>
                      {batch.processed}/{batch.total}
                      {batch.failed > 0 && (
                        <span className="dim">
                          {' '}
                          · {t('batches.failedCount', { count: batch.failed })}
                        </span>
                      )}
                    </td>
                    <td>
                      <Badge
                        tone={
                          batch.status === 'completed'
                            ? 'success'
                            : batch.status === 'completed_with_errors'
                              ? 'warning'
                              : 'info'
                        }
                      >
                        {statusLabel(t, batch.status)}
                      </Badge>
                    </td>
                    <td className="dim">{formatDateTime(batch.createdAt, locale)}</td>
                    <td className="row">
                      <button
                        className="button secondary small"
                        type="button"
                        onClick={() => void open(batch)}
                      >
                        {t('batches.items')}
                      </button>
                      <button
                        className="button secondary small"
                        type="button"
                        onClick={() => void download(batch)}
                      >
                        {t('batches.csv')}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>

        <Card
          title={selected ? t('batches.itemsFor', { name: selected.name }) : t('batches.items')}
        >
          {!selected ? (
            <EmptyState title={t('batches.choose')} hint={t('batches.chooseHint')} />
          ) : (
            <table className="table">
              <thead>
                <tr>
                  <th>#</th>
                  <th>{t('table.file')}</th>
                  <th>{t('table.status')}</th>
                  <th>{t('table.detail')}</th>
                </tr>
              </thead>
              <tbody>
                {selected.items.map((item) => (
                  <tr key={`${selected.id}-${item.position}`}>
                    <td className="dim">{item.position + 1}</td>
                    <td>{item.filename ?? '—'}</td>
                    <td>
                      <Badge tone={statusTone(item.status)}>{item.status}</Badge>
                    </td>
                    <td className="dim">
                      {item.error ??
                        (item.documentType ? documentTypeLabel(t, item.documentType) : '—')}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>
      </div>
    </div>
  );
}
