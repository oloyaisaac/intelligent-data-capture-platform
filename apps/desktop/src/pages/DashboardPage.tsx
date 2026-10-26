import React, { useEffect, useState } from 'react';
import type { DocumentSummary, ReviewQueueItem } from '@idcp/shared';
import type { ApiClient } from '../api/client';
import { connectRealtime, eventsUrl, type RealtimeEventName } from '../lib/realtime';
import { formatDateTime, formatPercent, statusTone } from '../lib/format';
import { buildBarChart, describeChart, shares } from '../lib/charts';
import { useLocale, useTranslator } from '../lib/locale';
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
  const t = useTranslator();
  const { locale } = useLocale();
  const stats = useAsync(() => client.stats(), []);
  const recent = useAsync(() => client.listDocuments({ limit: 8 }), []);
  const queue = useAsync(() => client.reviewQueue(5), []);
  const [live, setLive] = useState<'connecting' | 'live' | 'offline'>('connecting');
  const [events, setEvents] = useState<Array<{ event: RealtimeEventName; at: string }>>([]);
  const [exporting, setExporting] = useState(false);

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
  const timeline = stats.data?.timeline ?? [];
  const uploads = buildBarChart(timeline, 'uploaded');
  const statusShares = shares(documents);
  const typeEntries = Object.entries(stats.data?.documentTypes ?? {})
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5);

  return (
    <div className="stack">
      <ErrorBanner message={stats.error ?? recent.error} />

      <div className="row" style={{ justifyContent: 'space-between' }}>
        <h1>{t('nav.overview')}</h1>
        <div className="row">
          <Badge tone={live === 'live' ? 'success' : live === 'connecting' ? 'warning' : 'danger'}>
            {live === 'live'
              ? t('dashboard.live')
              : live === 'connecting'
                ? t('dashboard.connecting')
                : t('dashboard.offline')}
          </Badge>
          <button
            className="button secondary small"
            type="button"
            disabled={exporting}
            onClick={async () => {
              setExporting(true);
              try {
                const { blob, filename } = await client.downloadStatsCsv();
                const url = URL.createObjectURL(blob);
                const link = document.createElement('a');
                link.href = url;
                link.download = filename;
                link.click();
                URL.revokeObjectURL(url);
              } finally {
                setExporting(false);
              }
            }}
          >
            {exporting ? t('dashboard.preparing') : t('dashboard.downloadFigures')}
          </button>
        </div>
      </div>

      <div className="stats-grid">
        {[
          [
            t('dashboard.stat.documents'),
            Object.values(documents).reduce((sum, value) => sum + value, 0),
          ],
          [t('dashboard.stat.needsReview'), documents.needs_review ?? 0],
          [t('dashboard.stat.approved'), documents.approved ?? 0],
          [t('dashboard.stat.processing'), (documents.processing ?? 0) + (documents.queued ?? 0)],
          [t('dashboard.stat.failed'), documents.failed ?? 0],
        ].map(([label, value]) => (
          <div className="stat" key={String(label)}>
            <div className="stat-value">{value}</div>
            <div className="stat-label">{label}</div>
          </div>
        ))}
      </div>

      <div className="split">
        <Card title={t('dashboard.uploadsWindow', { days: 14 })}>
          {timeline.length === 0 ? (
            <EmptyState title={t('dashboard.noActivity')} hint={t('dashboard.noActivityHint')} />
          ) : (
            <div className="stack" style={{ gap: 8 }}>
              <svg
                role="img"
                aria-label={describeChart(uploads, t('dashboard.chartUploads'), t)}
                viewBox={`0 0 ${uploads.width} ${uploads.height + 18}`}
                width="100%"
                height={uploads.height + 18}
                preserveAspectRatio="none"
              >
                {uploads.gridlines.map((line) => (
                  <line
                    key={line.y}
                    x1={0}
                    x2={uploads.width}
                    y1={line.y}
                    y2={line.y}
                    stroke="currentColor"
                    strokeOpacity={0.12}
                    strokeDasharray="3 3"
                  />
                ))}
                {uploads.bars.map((bar) => (
                  <rect
                    key={bar.date}
                    x={bar.x}
                    y={bar.y}
                    width={bar.width}
                    height={bar.height}
                    rx={2}
                    fill="currentColor"
                    fillOpacity={bar.value === 0 ? 0.12 : 0.75}
                  >
                    <title>{`${bar.date}: ${bar.value}`}</title>
                  </rect>
                ))}
                {uploads.bars.map((bar) => (
                  <text
                    key={`label-${bar.date}`}
                    x={bar.x + bar.width / 2}
                    y={uploads.height + 13}
                    textAnchor="middle"
                    fontSize={9}
                    fill="currentColor"
                    fillOpacity={0.55}
                  >
                    {bar.label}
                  </text>
                ))}
              </svg>
              <div className="row" style={{ gap: 16 }}>
                <span className="dim">{t('dashboard.peakDay', { count: uploads.max })}</span>
                <span className="dim">
                  {t('dashboard.approvedWaiting', {
                    approved: stats.data?.review.approved ?? 0,
                    pending: stats.data?.review.pending ?? 0,
                  })}
                </span>
              </div>
            </div>
          )}
        </Card>

        <Card title={t('dashboard.latestUploads')}>
          {recent.loading && total === 0 ? (
            <EmptyState title={t('dashboard.loading')} />
          ) : recent.data && recent.data.items.length > 0 ? (
            <table className="table">
              <thead>
                <tr>
                  <th>{t('table.document')}</th>
                  <th>{t('table.type')}</th>
                  <th>{t('table.status')}</th>
                  <th>{t('table.uploaded')}</th>
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
                    <td className="dim">{formatDateTime(document.createdAt, locale)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <EmptyState title={t('dashboard.noDocuments')} hint={t('dashboard.noDocumentsHint')} />
          )}
        </Card>

        <div className="stack">
          <Card title={t('dashboard.waitingForReviewer')}>
            {queue.data && queue.data.items.length > 0 ? (
              <table className="table">
                <thead>
                  <tr>
                    <th>{t('table.document')}</th>
                    <th>{t('table.confidence')}</th>
                    <th>{t('table.fieldsToCheck')}</th>
                  </tr>
                </thead>
                <tbody>
                  {queue.data.items.map((item: ReviewQueueItem) => (
                    <tr key={item.document.id}>
                      <td>{item.document.documentType}</td>
                      <td
                        className={`confidence ${item.confidence && item.confidence >= 0.85 ? 'ok' : 'medium'}`}
                      >
                        {formatPercent(item.confidence, locale)}
                      </td>
                      <td>{item.blockingFields.length}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <EmptyState
                title={t('dashboard.nothingToReview')}
                hint={t('dashboard.nothingToReviewHint')}
              />
            )}
          </Card>

          <Card title={t('dashboard.mixByStatus')}>
            {statusShares.length === 0 ? (
              <EmptyState title={t('dashboard.nothingCaptured')} />
            ) : (
              <div className="stack" style={{ gap: 6 }}>
                <div
                  className="row"
                  style={{ height: 12, borderRadius: 6, overflow: 'hidden', gap: 0 }}
                  aria-hidden="true"
                >
                  {statusShares.map((slice) => (
                    <div
                      key={slice.key}
                      style={{
                        width: `${slice.percent}%`,
                        height: '100%',
                        background: `var(--tone-${statusTone(slice.key)})`,
                      }}
                      title={`${slice.key}: ${slice.value}`}
                    />
                  ))}
                </div>
                <ul style={{ margin: 0, paddingLeft: 18 }}>
                  {statusShares.map((slice) => (
                    <li key={slice.key} className="dim">
                      {slice.key.replace('_', ' ')} — {slice.value} ({slice.percent}%)
                    </li>
                  ))}
                </ul>
                {typeEntries.length > 0 && (
                  <p className="dim" style={{ margin: 0 }}>
                    {t('dashboard.types', {
                      list: typeEntries.map(([type, count]) => `${type} ${count}`).join(' · '),
                    })}
                  </p>
                )}
              </div>
            )}
          </Card>

          <Card title={t('dashboard.activity')}>
            {events.length === 0 ? (
              <p className="muted" style={{ margin: 0 }}>
                {t('dashboard.noEvents')}
              </p>
            ) : (
              <ul style={{ margin: 0, paddingLeft: 18 }}>
                {events.map((entry, index) => (
                  <li key={`${entry.event}-${index}`} className="dim">
                    <span className="mono">{entry.event}</span> · {formatDateTime(entry.at, locale)}
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
