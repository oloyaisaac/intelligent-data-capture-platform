import React, { useEffect, useMemo, useState } from 'react';
import { DOCUMENT_TYPES, type ReviewQueueItem, type ReviewSession } from '@idcp/shared';
import type { ApiClient } from '../api/client';
import {
  blockingReasonLabel,
  canApprove,
  documentTypeReason,
  pendingChanges,
  reviewRows,
} from '../lib/review';
import { confidenceTone, formatDateTime, formatPercent, titleCase } from '../lib/format';
import { Badge, Card, EmptyState, ErrorBanner, Modal, useAsync } from '../components/ui';
import { SendToDestination } from '../components/SendToDestination';

/**
 * REV-001 — the review workspace.
 *
 * Layout: queue on the left (least confident first), the record on the right with risky fields at
 * the top. A value is edited by clicking it, typing, and leaving the field — one click plus typing.
 * Approval is refused by the server while anything is unresolved, and the button says why.
 */
export function ReviewPage({
  client,
  initialDocumentId,
}: {
  client: ApiClient;
  initialDocumentId?: string;
}): React.JSX.Element {
  const queue = useAsync(() => client.reviewQueue(50), []);
  const [session, setSession] = useState<ReviewSession | null>(null);
  const [edited, setEdited] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [rejecting, setRejecting] = useState(false);
  const [rejectReason, setRejectReason] = useState('');
  const [syncKey, setSyncKey] = useState(0);
  /** Kept after approval so the record can still be sent to a destination (DUP-001). */
  const [approvedDocumentId, setApprovedDocumentId] = useState<string | null>(null);
  /** DESK-002: bulk approval works on the queue, and reports what it refused and why. */
  const [selected, setSelected] = useState<string[]>([]);
  const [bulk, setBulk] = useState<{ approved: number; skipped: ReviewQueueItem[] } | null>(null);
  void syncKey;

  const cleanIds = useMemo(
    () => (queue.data?.items ?? []).filter((item) => item.blockingFields.length === 0),
    [queue.data],
  );

  const toggleSelected = (documentId: string, next: boolean) => {
    setSelected((current) =>
      next ? [...new Set([...current, documentId])] : current.filter((id) => id !== documentId),
    );
  };

  const bulkApprove = async () => {
    if (selected.length === 0) return;
    setBusy(true);
    setError(null);
    setBulk(null);
    try {
      const result = await client.bulkApprove(selected);
      const skipped = (queue.data?.items ?? []).filter((item) =>
        result.skipped.some((entry) => entry.documentId === item.document.id),
      );
      setBulk({ approved: result.approved.length, skipped });
      setSelected([]);
      setSession(null);
      setNotice(
        result.skipped.length === 0
          ? `${result.approved.length} record(s) approved.`
          : `${result.approved.length} approved, ${result.skipped.length} left for a human.`,
      );
      await queue.reload();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not approve those records.');
    } finally {
      setBusy(false);
    }
  };

  const open = async (documentId: string) => {
    setBusy(true);
    setError(null);
    setNotice(null);
    setEdited({});
    setApprovedDocumentId(null);
    try {
      setSession(await client.openReview(documentId));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not open that record.');
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    if (initialDocumentId) void open(initialDocumentId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialDocumentId]);

  const rows = useMemo(() => (session ? reviewRows(session.udm, session.blocking) : []), [session]);
  const typeBlocker = session ? documentTypeReason(session.blocking) : null;
  const approveDisabled = !session || !canApprove(session.blocking) || busy;

  const save = async () => {
    if (!session) return;
    const changes = pendingChanges(rows, edited);
    if (changes.length === 0) {
      setNotice('No changes to save.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const result = await client.patchFields(session.reviewId, changes);
      setSession({
        ...session,
        blocking: result.blocking,
        udm: session.udm,
      });
      setEdited({});
      setNotice(`${changes.length} change${changes.length === 1 ? '' : 's'} recorded.`);
      setSyncKey((value) => value + 1);
      await queue.reload();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not save those changes.');
    } finally {
      setBusy(false);
    }
  };

  const confirmType = async (documentType: string) => {
    if (!session) return;
    setBusy(true);
    setError(null);
    try {
      const result = await client.patchFields(session.reviewId, [], documentType);
      setSession({ ...session, blocking: result.blocking, documentType: result.documentType });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not confirm the document type.');
    } finally {
      setBusy(false);
    }
  };

  const approve = async () => {
    if (!session) return;
    setBusy(true);
    setError(null);
    try {
      await client.approveReview(session.reviewId);
      setNotice('Record approved. It can now be sent to a destination.');
      setApprovedDocumentId(session.document.id);
      setSession(null);
      await queue.reload();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not approve this record.');
    } finally {
      setBusy(false);
    }
  };

  const reject = async () => {
    if (!session) return;
    setBusy(true);
    setError(null);
    try {
      await client.rejectReview(session.reviewId, rejectReason.trim());
      setRejecting(false);
      setRejectReason('');
      setSession(null);
      setNotice('Record rejected.');
      await queue.reload();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not reject this record.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="stack">
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <h1>Review</h1>
        {session && (
          <div className="row">
            <button className="button secondary" type="button" onClick={() => setSession(null)}>
              Close record
            </button>
            <button
              className="button secondary"
              type="button"
              onClick={() => setRejecting(true)}
              disabled={busy}
            >
              Reject
            </button>
            <button
              className="button"
              type="button"
              onClick={() => void approve()}
              disabled={approveDisabled}
              title={
                approveDisabled && session.blocking.length > 0
                  ? 'Resolve the highlighted fields first.'
                  : undefined
              }
            >
              Approve
            </button>
          </div>
        )}
      </div>

      <ErrorBanner message={error ?? queue.error} />
      {notice && (
        <div className="notice" role="status">
          {notice}
        </div>
      )}
      {bulk && bulk.skipped.length > 0 && (
        <div className="banner warning" role="status">
          <strong>Skipped {bulk.skipped.length}.</strong> These records still have fields to
          resolve:{' '}
          {bulk.skipped
            .map((item) => `${item.document.documentType} (${item.blockingFields.length})`)
            .join(', ')}
          .
        </div>
      )}

      <div className="split">
        <Card
          title={`Queue (${queue.data?.total ?? 0})`}
          actions={
            queue.data && queue.data.items.length > 0 ? (
              <div className="row">
                <button
                  className="button secondary small"
                  type="button"
                  disabled={cleanIds.length === 0 || busy}
                  onClick={() => setSelected(cleanIds.map((item) => item.document.id))}
                  title={
                    cleanIds.length === 0
                      ? 'Every record here still has a field worth a look.'
                      : 'Select only the records with nothing left to check'
                  }
                >
                  Select clean ({cleanIds.length})
                </button>
                <button
                  className="button small"
                  type="button"
                  disabled={selected.length === 0 || busy}
                  onClick={() => void bulkApprove()}
                >
                  Approve selected ({selected.length})
                </button>
              </div>
            ) : null
          }
        >
          {queue.loading && !queue.data ? (
            <EmptyState title="Loading…" />
          ) : (queue.data?.items.length ?? 0) === 0 ? (
            <EmptyState title="Nothing to review" hint="New captures appear here automatically." />
          ) : (
            <table className="table">
              <thead>
                <tr>
                  <th style={{ width: 28 }}>
                    <span className="sr-only">Select</span>
                  </th>
                  <th>Type</th>
                  <th>Confidence</th>
                  <th>To check</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {queue.data!.items.map((item: ReviewQueueItem) => (
                  <tr
                    key={item.document.id}
                    className={session?.document.id === item.document.id ? 'selected' : ''}
                  >
                    <td>
                      <input
                        type="checkbox"
                        aria-label={`Select ${item.document.documentType} ${item.document.id}`}
                        checked={selected.includes(item.document.id)}
                        onChange={(event) => toggleSelected(item.document.id, event.target.checked)}
                      />
                    </td>
                    <td>
                      <div>{titleCase(item.document.documentType)}</div>
                      <div className="dim">{formatDateTime(item.document.createdAt)}</div>
                    </td>
                    <td className={`confidence ${confidenceTone(item.confidence)}`}>
                      {formatPercent(item.confidence)}
                    </td>
                    <td>{item.blockingFields.length}</td>
                    <td>
                      <button
                        className="button secondary small"
                        type="button"
                        onClick={() => void open(item.document.id)}
                      >
                        Open
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>

        {session ? (
          <Card
            title="Record"
            actions={
              <Badge tone={session.blocking.length > 0 ? 'warning' : 'success'}>
                {session.blocking.length > 0
                  ? `${session.blocking.length} to resolve`
                  : 'Ready to approve'}
              </Badge>
            }
          >
            <div className="stack">
              <div className="row" style={{ gap: 12, flexWrap: 'wrap' }}>
                <label className="field" style={{ minWidth: 200 }}>
                  <span className="label">Document type</span>
                  <select
                    className="select"
                    value={session.documentType}
                    onChange={(event) => void confirmType(event.target.value)}
                  >
                    {DOCUMENT_TYPES.map((type) => (
                      <option key={type} value={type}>
                        {titleCase(type)}
                      </option>
                    ))}
                  </select>
                </label>
                <div>
                  <div className="label">Type confidence</div>
                  <div className={`confidence ${confidenceTone(session.documentTypeConfidence)}`}>
                    {formatPercent(session.documentTypeConfidence)}
                  </div>
                </div>
                {typeBlocker && (
                  <div className="notice" style={{ alignSelf: 'center' }}>
                    Confirm the document type before approving.
                  </div>
                )}
              </div>

              <div>
                {rows.map((row) => {
                  const tone = confidenceTone(row.confidence);
                  const riskClass =
                    row.reason === 'missing_value' || row.value === ''
                      ? ' risk-high'
                      : row.needsReview
                        ? ' risk'
                        : '';
                  const value = row.path in edited ? edited[row.path]! : row.value;
                  return (
                    <div className={`field-row${riskClass}`} key={row.path}>
                      <div className="field-label">
                        {row.label}
                        <span className="path">{row.path}</span>
                      </div>
                      <input
                        className="input"
                        value={value}
                        aria-label={`${row.label} value`}
                        placeholder={row.reason ? blockingReasonLabel(row.reason) : ''}
                        onChange={(event) =>
                          setEdited({ ...edited, [row.path]: event.target.value })
                        }
                      />
                      <div className="stack" style={{ gap: 2 }}>
                        <span className={`confidence ${tone}`}>
                          {formatPercent(row.confidence)}
                        </span>
                        {row.needsReview && (
                          <span className="dim">
                            {blockingReasonLabel(row.reason ?? 'low_confidence')}
                          </span>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>

              {session.udm.tables.length > 0 && (
                <div>
                  <h3 className="card-title" style={{ marginBottom: 8 }}>
                    Line items
                  </h3>
                  <table className="table">
                    <thead>
                      <tr>
                        {session.udm.tables[0]!.columns.map((column) => (
                          <th key={column.key}>{column.label}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {session.udm.tables[0]!.rows.slice(0, 25).map((row, index) => (
                        <tr key={index}>
                          {row.map((cell, cellIndex) => (
                            <td key={cellIndex}>
                              {cell === null || cell === undefined ? '—' : String(cell)}
                            </td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}

              <div className="row">
                <button
                  className="button secondary"
                  type="button"
                  onClick={() => setEdited({})}
                  disabled={busy}
                >
                  Discard edits
                </button>
                <button
                  className="button"
                  type="button"
                  onClick={() => void save()}
                  disabled={busy || Object.keys(edited).length === 0}
                >
                  Save changes
                </button>
                <span className="muted">
                  {Object.keys(edited).length === 0
                    ? 'Click a value to correct it.'
                    : `${Object.keys(edited).length} unsaved`}
                </span>
              </div>

              <p className="dim" style={{ margin: 0 }}>
                Every correction records the previous value, the new value and your name.
                Corrections are only used to improve extraction when your organisation opts in.
              </p>
            </div>
          </Card>
        ) : (
          <Card title="Record">
            <EmptyState
              title="Select a record"
              hint="Open a record from the queue to check its fields."
            />
          </Card>
        )}
      </div>

      {(session || approvedDocumentId) && (
        <SendToDestination
          client={client}
          documentId={session?.document.id ?? approvedDocumentId ?? ''}
          approved={session ? session.document.status === 'approved' : true}
        />
      )}

      {rejecting && (
        <Modal
          title="Reject this record"
          onClose={() => setRejecting(false)}
          footer={
            <>
              <button
                className="button secondary"
                type="button"
                onClick={() => setRejecting(false)}
              >
                Cancel
              </button>
              <button
                className="button danger"
                type="button"
                disabled={rejectReason.trim().length === 0 || busy}
                onClick={() => void reject()}
              >
                Reject
              </button>
            </>
          }
        >
          <label className="field">
            <span className="label">Reason (stored in the audit trail)</span>
            <textarea
              className="textarea"
              rows={3}
              value={rejectReason}
              onChange={(event) => setRejectReason(event.target.value)}
            />
          </label>
        </Modal>
      )}
    </div>
  );
}
