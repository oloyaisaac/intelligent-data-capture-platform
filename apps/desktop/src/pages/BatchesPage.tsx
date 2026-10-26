import React, { useState } from 'react';
import { DOCUMENT_TYPES, type BatchSummary } from '@idcp/shared';
import type { ApiClient } from '../api/client';
import { formatDateTime, statusTone } from '../lib/format';
import { Badge, Card, EmptyState, ErrorBanner, Field, useAsync, useTick } from '../components/ui';

/**
 * BATCH-001 — batch upload on the desktop.
 *
 * Files are chosen once and uploaded in a single request. The list then polls while anything is
 * still processing, because progress lives on the server (derived from the documents) and a second
 * source of truth in the UI would drift.
 */
export function BatchesPage({ client }: { client: ApiClient }): React.JSX.Element {
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
      setError(caught instanceof Error ? caught.message : 'The batch could not be uploaded.');
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
      setError(caught instanceof Error ? caught.message : 'Could not download the results.');
    }
  };

  const open = async (batch: BatchSummary) => {
    try {
      setSelected(await client.getBatch(batch.id));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not open the batch.');
    }
  };

  return (
    <div className="stack">
      <h1>Batches</h1>
      <ErrorBanner message={error ?? batches.error} />

      <Card title="Upload a batch">
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
            aria-label="Choose files"
          />
          {files.length > 0 && <p className="dim">{files.length} file(s) selected</p>}

          <div className="row">
            <Field label="Batch name">
              <input
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder="Morning intake"
                maxLength={120}
              />
            </Field>
            <Field label="Project">
              <select value={projectId} onChange={(event) => setProjectId(event.target.value)}>
                <option value="">No project</option>
                {(projects.data?.items ?? []).map((project) => (
                  <option key={project.id} value={project.id}>
                    {project.name}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Document type" hint="Optional — the pipeline detects it otherwise.">
              <select
                value={documentType}
                onChange={(event) => setDocumentType(event.target.value)}
              >
                <option value="">Detect automatically</option>
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
              {busy ? 'Uploading…' : `Upload ${files.length || ''} file(s)`}
            </button>
            <span className="dim">Up to 100 files per batch.</span>
          </div>
        </div>
      </Card>

      <div className="grid two">
        <Card title="Recent batches">
          {items.length === 0 ? (
            <EmptyState title="No batches yet" hint="Upload several files at once to start one." />
          ) : (
            <table className="table">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Progress</th>
                  <th>Status</th>
                  <th>Created</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {items.map((batch) => (
                  <tr key={batch.id}>
                    <td>{batch.name}</td>
                    <td>
                      {batch.processed}/{batch.total}
                      {batch.failed > 0 && <span className="dim"> · {batch.failed} failed</span>}
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
                        {batch.status.replace(/_/g, ' ')}
                      </Badge>
                    </td>
                    <td className="dim">{formatDateTime(batch.createdAt)}</td>
                    <td className="row">
                      <button
                        className="button secondary small"
                        type="button"
                        onClick={() => void open(batch)}
                      >
                        Items
                      </button>
                      <button
                        className="button secondary small"
                        type="button"
                        onClick={() => void download(batch)}
                      >
                        CSV
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>

        <Card title={selected ? `Items — ${selected.name}` : 'Items'}>
          {!selected ? (
            <EmptyState title="Choose a batch" hint="Its per-file results appear here." />
          ) : (
            <table className="table">
              <thead>
                <tr>
                  <th>#</th>
                  <th>File</th>
                  <th>Status</th>
                  <th>Detail</th>
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
                    <td className="dim">{item.error ?? item.documentType ?? '—'}</td>
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
