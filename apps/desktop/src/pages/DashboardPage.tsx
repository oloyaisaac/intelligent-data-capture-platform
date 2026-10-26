import React, { useEffect, useState } from 'react';
import type { DocumentSummary, ReviewQueueItem } from '@idcp/shared';
import type { ApiClient } from '../api/client';
import { connectRealtime, eventsUrl, type RealtimeEventName } from '../lib/realtime';
import { formatDateTime, formatPercent, statusTone } from '../lib/format';
import { Badge, Card, EmptyState, ErrorBanner, useAsync } from '../components/ui';

/**
 * DESK-002 — the dashboard.
 *
 * New uploads and approvals arrive over the event stream; the counts are re-read after each event
 * so the screen shows authoritative figures rather than guesses. Everything on this page is
 * derived from auditable records (documents, reviews, exports).
 */
export function DashboardPage({
  client,
  accessToken,
  onOpenDocument,
}: {
  client: ApiClient;
  accessToken: string | null;
  onOpenDocument?: (documentId: string) => void;
}): React.JSX.Element {
  const stats = useAsync(() => client.stats(), []);
  const recent = useAsync(() => client.listDocuments({ limit: 8 }), []);
  const queue = useAsync(() => client.reviewQueue(5), []);
  const [live, setLive] = useState<'connecting' | 'live' | 'offline'>('connecting');
  const [events, setEvents] = useState<Array<{ event: RealtimeEventName; at: string }>>([]);

  useEffect(() => {
    if (!accessToken) return;
    const connection = connectRealtime({
      url: eventsUrl(accessToken),
      onStatusChange: setLive,
      onEvent: (event) => {
        setEvents((previous) => [{ event, at: new Date().toISOString() }, ...previous].slice(0, 8));
        void stats.reload();
        void recent.reload();
        if (event === 'document:needs_review' || event === 'document:approved') void queue.reload();
      },
    });
    return () => connection.close();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accessToken]);

  const documents = stats.data?.documents ?? {};
  const total = recent.data?.items.length ?? 0;

  return (
    <div className="stack">
      <ErrorBanner message={stats.error ?? recent.error} />

      <div className="row" style={{ justifyContent: 'space-between' }}>
        <h1>Overview</h1>
        <Badge tone={live === 'live' ? 'success' : live === 'connecting' ? 'warning' : 'danger'}>
          {live === 'live' ? 'Live' : live === 'connecting' ? 'Connecting' : 'Offline'}
        </Badge>
      </div>

      <div className="stats-grid">
        {[
          ['Documents', Object.values(documents).reduce((sum, value) => sum + value, 0)],
          ['Needs review', documents.needs_review ?? 0],
          ['Approved', documents.approved ?? 0],
          ['Processing', (documents.processing ?? 0) + (documents.queued ?? 0)],
          ['Failed', documents.failed ?? 0],
        ].map(([label, value]) => (
          <div className="stat" key={String(label)}>
            <div className="stat-value">{value}</div>
            <div className="stat-label">{label}</div>
          </div>
        ))}
      </div>

      <div className="split">
        <Card title="Latest uploads">
          {recent.loading && total === 0 ? (
            <EmptyState title="Loading…" />
          ) : recent.data && recent.data.items.length > 0 ? (
            <table className="table">
              <thead>
                <tr>
                  <th>Document</th>
                  <th>Type</th>
                  <th>Status</th>
                  <th>Uploaded</th>
                </tr>
              </thead>
              <tbody>
                {recent.data.items.map((document: DocumentSummary) => (
                  <tr key={document.id}>
                    <td>
                      {onOpenDocument ? (
                        <button
                          className="nav-item"
                          style={{ padding: 0, width: 'auto' }}
                          onClick={() => onOpenDocument(document.id)}
                        >
                          {document.id.slice(0, 8)}
                        </button>
                      ) : (
                        <span className="mono">{document.id.slice(0, 8)}</span>
                      )}
                    </td>
                    <td>{document.documentType}</td>
                    <td>
                      <Badge tone={statusTone(document.status)}>
                        {document.status.replace('_', ' ')}
                      </Badge>
                    </td>
                    <td className="dim">{formatDateTime(document.createdAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <EmptyState
              title="No documents yet"
              hint="Upload a scan from Documents, or capture one on your phone."
            />
          )}
        </Card>

        <div className="stack">
          <Card title="Waiting for a reviewer">
            {queue.data && queue.data.items.length > 0 ? (
              <table className="table">
                <thead>
                  <tr>
                    <th>Document</th>
                    <th>Confidence</th>
                    <th>Fields to check</th>
                  </tr>
                </thead>
                <tbody>
                  {queue.data.items.map((item: ReviewQueueItem) => (
                    <tr key={item.document.id}>
                      <td>{item.document.documentType}</td>
                      <td
                        className={`confidence ${item.confidence && item.confidence >= 0.85 ? 'ok' : 'medium'}`}
                      >
                        {formatPercent(item.confidence)}
                      </td>
                      <td>{item.blockingFields.length}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <EmptyState title="Nothing to review" hint="Everything captured has been checked." />
            )}
          </Card>

          <Card title="Activity">
            {events.length === 0 ? (
              <p className="muted" style={{ margin: 0 }}>
                Events will appear here as documents are captured and approved.
              </p>
            ) : (
              <ul style={{ margin: 0, paddingLeft: 18 }}>
                {events.map((entry, index) => (
                  <li key={`${entry.event}-${index}`} className="dim">
                    <span className="mono">{entry.event}</span> · {formatDateTime(entry.at)}
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>
      </div>
    </div>
  );
}
