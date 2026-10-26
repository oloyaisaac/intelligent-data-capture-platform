import React, { useEffect, useMemo, useState } from 'react';
import type { DuplicateCheckResponse } from '@idcp/shared';
import type { ApiClient } from '../api/client';
import { Badge, Card, ErrorBanner, Field, useAsync } from './ui';
import { formatPercent } from '../lib/format';
import { useLocale, useTranslator } from '../lib/locale';

/**
 * DUP-001 / MAP-001 — send an approved record to a destination.
 *
 * The duplicate check happens before the write and is shown as a score plus the fields that
 * matched, because "this looks like a duplicate" without evidence is not something a bookkeeper
 * can act on. Sending is only offered for an approved record and an active connector.
 */
export function SendToDestination({
  client,
  documentId,
  approved,
}: {
  client: ApiClient;
  documentId: string;
  approved: boolean;
}): React.JSX.Element {
  const t = useTranslator();
  const { locale } = useLocale();
  const connectors = useAsync(() => client.listConnectors(), []);
  const mappings = useAsync(() => client.listMappingProfiles(), []);

  const [connectorId, setConnectorId] = useState('');
  const [mappingProfileId, setMappingProfileId] = useState('');
  const [check, setCheck] = useState<DuplicateCheckResponse | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const activeConnectors = useMemo(
    () => (connectors.data?.items ?? []).filter((connector) => connector.status === 'active'),
    [connectors.data],
  );

  // Only mappings that belong to the chosen connector make sense in the second picker.
  const availableMappings = useMemo(
    () => (mappings.data?.items ?? []).filter((mapping) => mapping.connectorId === connectorId),
    [mappings.data, connectorId],
  );

  useEffect(() => {
    setCheck(null);
    setNotice(null);
    if (availableMappings.length === 1) setMappingProfileId(availableMappings[0]?.id ?? '');
    else if (!availableMappings.some((mapping) => mapping.id === mappingProfileId)) {
      setMappingProfileId('');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connectorId, availableMappings.length]);

  const runCheck = async () => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      setCheck(await client.checkDuplicates(documentId, { connectorId, mappingProfileId }));
    } catch (caught) {
      setCheck(null);
      setError(caught instanceof Error ? caught.message : t('send.checkFailed'));
    } finally {
      setBusy(false);
    }
  };

  const send = async () => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const result = await client.sendDocument(documentId, { connectorId, mappingProfileId });
      setNotice(
        result.status === 'skipped_duplicate'
          ? t('send.skippedDuplicate')
          : t('send.sent', { count: result.created + result.updated }),
      );
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : t('send.failed'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card title={t('send.card')}>
      <div className="stack">
        <ErrorBanner message={error ?? connectors.error ?? mappings.error} />

        {!approved && (
          <p className="muted" style={{ margin: 0 }}>
            {t('send.approveFirst')}
          </p>
        )}

        <div className="row" style={{ alignItems: 'flex-end' }}>
          <Field label={t('send.connector')}>
            <select
              className="select"
              value={connectorId}
              onChange={(event) => setConnectorId(event.target.value)}
            >
              <option value="">{t('send.chooseConnector')}</option>
              {activeConnectors.map((connector) => (
                <option key={connector.id} value={connector.id}>
                  {connector.name}
                </option>
              ))}
            </select>
          </Field>

          <Field label={t('send.mappingProfile')}>
            <select
              className="select"
              value={mappingProfileId}
              onChange={(event) => setMappingProfileId(event.target.value)}
              disabled={availableMappings.length === 0}
            >
              <option value="">
                {availableMappings.length === 0 ? t('send.noMappings') : t('send.chooseMapping')}
              </option>
              {availableMappings.map((mapping) => (
                <option key={mapping.id} value={mapping.id}>
                  {mapping.name} ({mapping.documentType})
                </option>
              ))}
            </select>
          </Field>

          <button
            className="button secondary"
            type="button"
            disabled={busy || !connectorId || !mappingProfileId}
            onClick={() => void runCheck()}
          >
            {t('send.checkDuplicates')}
          </button>
          <button
            className="button"
            type="button"
            disabled={busy || !approved || !connectorId || !mappingProfileId}
            onClick={() => void send()}
          >
            {t('send.send')}
          </button>
        </div>

        {notice && (
          <div className="notice" role="status">
            {notice}
          </div>
        )}

        {check && (
          <div className="stack" style={{ gap: 6 }} role="status">
            <div className="row">
              <Badge tone={check.isDuplicate ? 'warning' : 'success'}>
                {check.isDuplicate ? t('send.duplicateFound') : t('send.noDuplicate')}
              </Badge>
              <span className="dim">
                {t('send.bestScore', {
                  best: formatPercent(check.bestScore, locale),
                  threshold: formatPercent(check.threshold, locale),
                  policy: check.policy,
                })}
              </span>
            </div>
            {check.keys.length === 0 ? (
              <p className="muted" style={{ margin: 0 }}>
                {t('send.noKeys')}
              </p>
            ) : check.matchedKeys.length > 0 ? (
              <p className="dim" style={{ margin: 0 }}>
                {t('send.matchedOn', { keys: check.matchedKeys.join(', ') })}
              </p>
            ) : (
              <p className="muted" style={{ margin: 0 }}>
                {t('send.noCandidate')}
              </p>
            )}

            {check.candidates.length > 0 && (
              <table className="table">
                <thead>
                  <tr>
                    <th>{t('table.score')}</th>
                    <th>{t('table.matchedKeys')}</th>
                    <th>{t('table.existingRow')}</th>
                  </tr>
                </thead>
                <tbody>
                  {check.candidates.map((candidate, index) => (
                    <tr key={`${candidate.score}-${index}`}>
                      <td
                        className={`confidence ${candidate.score >= check.threshold ? 'medium' : 'ok'}`}
                      >
                        {formatPercent(candidate.score, locale)}
                      </td>
                      <td className="mono">{candidate.matchedKeys.join(', ') || '—'}</td>
                      <td className="dim">
                        {Object.entries(candidate.values)
                          .slice(0, 4)
                          .map(([key, value]) => `${key}=${String(value)}`)
                          .join(' · ')}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        )}
      </div>
    </Card>
  );
}
