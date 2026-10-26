import React, { useState } from 'react';
import { DOCUMENT_TYPES, type ExportRecord } from '@idcp/shared';
import type { ApiClient } from '../api/client';
import { formatDateTime, statusTone } from '../lib/format';
import { Badge, Card, EmptyState, ErrorBanner, Field, useAsync } from '../components/ui';

/**
 * EXPORT-001 / EXPORT-002 — exports from the desktop.
 *
 * Only approved records are exported; the server builds the file, so a large export never blocks
 * the UI. The file is downloaded through the authenticated client rather than a bare link.
 */
export function ExportsPage({ client }: { client: ApiClient }): React.JSX.Element {
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
      setError(caught instanceof Error ? caught.message : 'Export failed.');
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
      setError(caught instanceof Error ? caught.message : 'Download failed.');
    }
  };

  const items = exports.data?.items ?? [];

  return (
    <div className="stack">
      <h1>Exports</h1>
      <ErrorBanner message={error ?? exports.error} />

      <Card title="New export">
        <div className="toolbar">
          <Field label="Format">
            <select
              className="select"
              value={format}
              onChange={(event) => setFormat(event.target.value as 'xlsx' | 'csv')}
            >
              <option value="xlsx">Excel workbook (.xlsx)</option>
              <option value="csv">CSV file (.csv)</option>
            </select>
          </Field>
          <Field label="Document type">
            <select
              className="select"
              value={documentType}
              onChange={(event) => setDocumentType(event.target.value)}
            >
              <option value="">All approved</option>
              {DOCUMENT_TYPES.map((type) => (
                <option key={type} value={type}>
                  {type}
                </option>
              ))}
            </select>
          </Field>
          <Field label="From">
            <input
              className="input"
              type="date"
              value={from}
              onChange={(event) => setFrom(event.target.value)}
            />
          </Field>
          <Field label="To">
            <input
              className="input"
              type="date"
              value={to}
              onChange={(event) => setTo(event.target.value)}
            />
          </Field>
          <button className="button" type="button" onClick={() => void create()} disabled={busy}>
            {busy ? 'Building…' : 'Export approved records'}
          </button>
        </div>
        <p className="dim" style={{ marginBottom: 0 }}>
          Values beginning with =, +, - or @ are neutralised so a spreadsheet never treats captured
          text as a formula.
        </p>
      </Card>

      <Card title="History">
        {items.length === 0 ? (
          <EmptyState title="No exports yet" hint="Approve a few records, then export them here." />
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>Created</th>
                <th>Format</th>
                <th>Status</th>
                <th>Rows</th>
                <th>Expires</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {items.map((record) => (
                <tr key={record.id}>
                  <td className="dim">{formatDateTime(record.createdAt)}</td>
                  <td>{record.format.toUpperCase()}</td>
                  <td>
                    <Badge tone={statusTone(record.status)}>{record.status}</Badge>
                  </td>
                  <td>{record.rowCount ?? '—'}</td>
                  <td className="dim">{formatDateTime(record.expiresAt ?? null)}</td>
                  <td style={{ textAlign: 'right' }}>
                    <button
                      className="button secondary small"
                      type="button"
                      disabled={record.status !== 'ready'}
                      onClick={() => void download(record)}
                    >
                      Download
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
