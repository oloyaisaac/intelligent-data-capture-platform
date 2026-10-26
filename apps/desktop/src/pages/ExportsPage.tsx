import React, { useState } from 'react';
import { DOCUMENT_TYPES, type ExportRecord } from '@idcp/shared';
import type { ApiClient } from '../api/client';
import { formatDateTime, statusTone } from '../lib/format';
import { Badge, Card, EmptyState, ErrorBanner, Field, useAsync } from '../components/ui';
import { useLocale, useTranslator } from '../lib/locale';
import { statusLabel } from '../lib/labels';

/**
 * EXPORT-001 / EXPORT-002 — exports from the desktop.
 *
 * Only approved records are exported; the server builds the file, so a large export never blocks
 * the UI. The file is downloaded through the authenticated client rather than a bare link.
 */
export function ExportsPage({ client }: { client: ApiClient }): React.JSX.Element {
  const t = useTranslator();
  const { locale } = useLocale();
  const exports = useAsync(() => client.listExports(), []);
  const [format, setFormat] = useState<'xlsx' | 'csv'>('xlsx');
  const [documentType, setDocumentType] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const create = async () => {
    setBusy(true);
    setError(null);
    try {
      await client.createExport({
        format,
        ...(documentType ? { documentType: documentType as (typeof DOCUMENT_TYPES)[number] } : {}),
        ...(from ? { from: new Date(`${from}T00:00:00.000Z`).toISOString() } : {}),
        ...(to ? { to: new Date(`${to}T23:59:59.999Z`).toISOString() } : {}),
      });
      await exports.reload();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : t('exports.failed'));
    } finally {
      setBusy(false);
    }
  };

  const download = async (record: ExportRecord) => {
    setError(null);
    try {
      const { blob, filename } = await client.downloadExport(record.id);
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = filename;
      anchor.click();
      URL.revokeObjectURL(url);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : t('exports.downloadFailed'));
    }
  };

  const items = exports.data?.items ?? [];

  return (
    <div className="stack">
      <h1>{t('exports.title')}</h1>
      <ErrorBanner message={error ?? exports.error} />

      <Card title={t('exports.new')}>
        <div className="toolbar">
          <Field label={t('exports.format')}>
            <select
              className="select"
              value={format}
              onChange={(event) => setFormat(event.target.value as 'xlsx' | 'csv')}
            >
              <option value="xlsx">{t('exports.xlsx')}</option>
              <option value="csv">CSV file (.csv)</option>
            </select>
          </Field>
          <Field label={t('filter.documentType')}>
            <select
              className="select"
              value={documentType}
              onChange={(event) => setDocumentType(event.target.value)}
            >
              <option value="">{t('exports.allApproved')}</option>
              {DOCUMENT_TYPES.map((type) => (
                <option key={type} value={type}>
                  {type}
                </option>
              ))}
            </select>
          </Field>
          <Field label={t('filter.from')}>
            <input
              className="input"
              type="date"
              value={from}
              onChange={(event) => setFrom(event.target.value)}
            />
          </Field>
          <Field label={t('filter.to')}>
            <input
              className="input"
              type="date"
              value={to}
              onChange={(event) => setTo(event.target.value)}
            />
          </Field>
          <button className="button" type="button" onClick={() => void create()} disabled={busy}>
            {busy ? t('exports.building') : t('exports.exportApproved')}
          </button>
        </div>
        <p className="dim" style={{ marginBottom: 0 }}>
          Values beginning with =, +, - or @ are neutralised so a spreadsheet never treats captured
          text as a formula.
        </p>
      </Card>

      <Card title={t('exports.history')}>
        {items.length === 0 ? (
          <EmptyState title={t('exports.none')} hint={t('exports.noneHint')} />
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>{t('table.created')}</th>
                <th>{t('table.format')}</th>
                <th>{t('table.status')}</th>
                <th>{t('table.rows')}</th>
                <th>{t('table.expires')}</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {items.map((record) => (
                <tr key={record.id}>
                  <td className="dim">{formatDateTime(record.createdAt, locale)}</td>
                  <td>{record.format.toUpperCase()}</td>
                  <td>
                    <Badge tone={statusTone(record.status)}>{statusLabel(t, record.status)}</Badge>
                  </td>
                  <td>{record.rowCount ?? '—'}</td>
                  <td className="dim">{formatDateTime(record.expiresAt ?? null, locale)}</td>
                  <td style={{ textAlign: 'end' }}>
                    <button
                      className="button secondary small"
                      type="button"
                      disabled={record.status !== 'ready'}
                      onClick={() => void download(record)}
                    >
                      {t('action.download')}
                    </button>
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
