import React, { useEffect, useMemo, useRef, useState } from 'react';
import { DOCUMENT_STATUSES, DOCUMENT_TYPES, type DocumentSummary } from '@idcp/shared';
import type { ApiClient } from '../api/client';
import { formatBytes, formatDateTime, isoDayEnd, isoDayStart, statusTone } from '../lib/format';
import { Badge, Card, EmptyState, ErrorBanner, Field, useAsync } from '../components/ui';
import { connectRealtime, eventsUrl } from '../lib/realtime';

export interface DocumentFilters {
  status: string;
  documentType: string;
  deviceId: string;
  from: string;
  to: string;
}

/**
 * DESK-002 — documents and jobs.
 *
 * Filters cover status, document type, device and a date range — the four ways somebody actually
 * hunts for a record. The list also refreshes itself when the server says something changed, so a
 * capture from a phone appears without pressing anything. Uploading from the desktop is supported
 * so a scanned file can be dropped in without a phone.
 */
export function DocumentsPage({
  client,
  onOpenReview,
  initial,
  accessToken = null,
}: {
  client: ApiClient;
  onOpenReview: (documentId: string) => void;
  initial?: Partial<DocumentFilters>;
  accessToken?: string | null;
}): React.JSX.Element {
  const [filters, setFilters] = useState<DocumentFilters>({
    status: initial?.status ?? '',
    documentType: initial?.documentType ?? '',
    deviceId: initial?.deviceId ?? '',
    from: initial?.from ?? '',
    to: initial?.to ?? '',
  });
  const devices = useAsync(() => client.listDevices(), []);
  const [uploading, setUploading] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  const query = useMemo(
    () => ({
      status: filters.status || undefined,
      documentType: filters.documentType || undefined,
      deviceId: filters.deviceId || undefined,
      from: isoDayStart(filters.from),
      to: isoDayEnd(filters.to),
      limit: 100,
    }),
    [filters],
  );

  const documents = useAsync(() => client.listDocuments(query), [query]);

  // DESK-002: a capture from a phone should appear here without a manual refresh. The stream is
  // best-effort — if it is not available the list still works, it just stops being live.
  useEffect(() => {
    if (!accessToken) return;
    const connection = connectRealtime({
      url: eventsUrl(accessToken),
      onEvent: (event) => {
        if (event.startsWith('document:') || event === 'job:progress') void documents.reload();
      },
    });
    return () => connection.close();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accessToken, query]);

  const upload = async (file: File) => {
    setUploading(true);
    setActionError(null);
    try {
      await client.uploadDocument(file, filters.documentType || undefined);
      await documents.reload();
    } catch (caught) {
      setActionError(caught instanceof Error ? caught.message : 'Upload failed.');
    } finally {
      setUploading(false);
      if (fileInput.current) fileInput.current.value = '';
    }
  };

  const act = async (action: () => Promise<unknown>) => {
    setActionError(null);
    try {
      await action();
      await documents.reload();
    } catch (caught) {
      setActionError(caught instanceof Error ? caught.message : 'Action failed.');
    }
  };

  const items = documents.data?.items ?? [];

  return (
    <div className="stack">
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <h1>Documents</h1>
        <div className="row">
          <input
            ref={fileInput}
            id="desktop-upload"
            type="file"
            accept="image/jpeg,image/png,image/heic,application/pdf"
            className="sr-only"
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) void upload(file);
            }}
          />
          <button
            className="button"
            disabled={uploading}
            onClick={() => fileInput.current?.click()}
            type="button"
          >
            {uploading ? 'Uploading…' : 'Upload a document'}
          </button>
        </div>
      </div>

      <ErrorBanner message={actionError ?? documents.error} />

      <Card>
        <div className="toolbar">
          <Field label="Status">
            <select
              className="select"
              value={filters.status}
              onChange={(event) => setFilters({ ...filters, status: event.target.value })}
            >
              <option value="">Any</option>
              {DOCUMENT_STATUSES.map((status) => (
                <option key={status} value={status}>
                  {status.replace('_', ' ')}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Document type">
            <select
              className="select"
              value={filters.documentType}
              onChange={(event) => setFilters({ ...filters, documentType: event.target.value })}
            >
              <option value="">Any</option>
              {DOCUMENT_TYPES.map((type) => (
                <option key={type} value={type}>
                  {type}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Device">
            <select
              className="select"
              value={filters.deviceId}
              onChange={(event) => setFilters({ ...filters, deviceId: event.target.value })}
            >
              <option value="">Any device</option>
              {(devices.data?.items ?? []).map((device) => (
                <option key={device.id} value={device.id}>
                  {device.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="From">
            <input
              className="input"
              type="date"
              value={filters.from}
              onChange={(event) => setFilters({ ...filters, from: event.target.value })}
            />
          </Field>
          <Field label="To">
            <input
              className="input"
              type="date"
              value={filters.to}
              onChange={(event) => setFilters({ ...filters, to: event.target.value })}
            />
          </Field>
          <button
            className="button secondary"
            type="button"
            onClick={() =>
              setFilters({ status: '', documentType: '', deviceId: '', from: '', to: '' })
            }
          >
            Clear
          </button>
        </div>
      </Card>

      <Card title={`${items.length} document${items.length === 1 ? '' : 's'}`}>
        {documents.loading && items.length === 0 ? (
          <EmptyState title="Loading…" />
        ) : items.length === 0 ? (
          <EmptyState
            title="Nothing matches those filters"
            hint="Try a wider date range or clear the status filter."
          />
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>Document</th>
                <th>Type</th>
                <th>Status</th>
                <th>Size</th>
                <th>Uploaded</th>
                <th aria-label="Actions" />
              </tr>
            </thead>
            <tbody>
              {items.map((document: DocumentSummary) => (
                <tr key={document.id}>
                  <td className="mono">{document.id.slice(0, 8)}</td>
                  <td>{document.documentType}</td>
                  <td>
                    <Badge tone={statusTone(document.status)}>
                      {document.status.replace('_', ' ')}
                    </Badge>
                  </td>
                  <td className="dim">{formatBytes(document.sizeBytes)}</td>
                  <td className="dim">{formatDateTime(document.createdAt)}</td>
                  <td>
                    <div className="row" style={{ justifyContent: 'flex-end' }}>
                      <a
                        className="button secondary small"
                        href={`/api/v1/documents/${document.id}/file`}
                        target="_blank"
                        rel="noreferrer"
                      >
                        View
                      </a>
                      <button
                        className="button secondary small"
                        type="button"
                        onClick={() => onOpenReview(document.id)}
                      >
                        Review
                      </button>
                      <button
                        className="button secondary small"
                        type="button"
                        onClick={() => void act(() => client.reprocess(document.id))}
                      >
                        Reprocess
                      </button>
                      <button
                        className="button danger small"
                        type="button"
                        onClick={() => {
                          if (
                            window.confirm(
                              'Delete this document and its file? This cannot be undone.',
                            )
                          ) {
                            void act(() => client.deleteDocument(document.id));
                          }
                        }}
                      >
                        Delete
                      </button>
                    </div>
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
