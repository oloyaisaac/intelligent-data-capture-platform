import React, { useEffect, useMemo, useState } from 'react';
import type { DuplicateCheckResponse } from '@idcp/shared';
import type { ApiClient } from '../api/client';
import { Badge, Card, ErrorBanner, Field, useAsync } from './ui';
import { formatPercent } from '../lib/format';

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
      setError(caught instanceof Error ? caught.message : 'Could not check the destination.');
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
          ? 'A matching row already exists, so nothing was written.'
          : `Sent: ${result.created + result.updated} row(s) written.`,
      );
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not send this record.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card title="Send to a destination">
      <div className="stack">
        <ErrorBanner message={error ?? connectors.error ?? mappings.error} />

        {!approved && (
          <p className="muted" style={{ margin: 0 }}>
            Approve this record before sending it to a connector.
          </p>
        )}

        <div className="row" style={{ alignItems: 'flex-end' }}>
          <Field label="Connector">
            <select
              className="select"
              value={connectorId}
              onChange={(event) => setConnectorId(event.target.value)}
            >
              <option value="">Choose a connector</option>
              {activeConnectors.map((connector) => (
                <option key={connector.id} value={connector.id}>
                  {connector.name}
                </option>
              ))}
            </select>
          </Field>

          <Field label="Mapping profile">
            <select
              className="select"
              value={mappingProfileId}
              onChange={(event) => setMappingProfileId(event.target.value)}
              disabled={availableMappings.length === 0}
            >
              <option value="">
                {availableMappings.length === 0
                  ? 'No mappings for this connector'
                  : 'Choose a mapping'}
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
            Check for duplicates
          </button>
          <button
            className="button"
            type="button"
            disabled={busy || !approved || !connectorId || !mappingProfileId}
            onClick={() => void send()}
          >
            Send
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
                {check.isDuplicate ? 'duplicate found' : 'no duplicate'}
              </Badge>
              <span className="dim">
                best score {formatPercent(check.bestScore)} · threshold{' '}
                {formatPercent(check.threshold)} · policy {check.policy}
              </span>
            </div>
            {check.keys.length === 0 ? (
              <p className="muted" style={{ margin: 0 }}>
                This mapping profile has no duplicate keys, so nothing is compared.
              </p>
            ) : check.matchedKeys.length > 0 ? (
              <p className="dim" style={{ margin: 0 }}>
                Matched on: <span className="mono">{check.matchedKeys.join(', ')}</span>
              </p>
            ) : (
              <p className="muted" style={{ margin: 0 }}>
                No candidate matched the configured keys.
              </p>
            )}

            {check.candidates.length > 0 && (
              <table className="table">
                <thead>
                  <tr>
                    <th>Score</th>
                    <th>Matched keys</th>
                    <th>Existing row</th>
                  </tr>
                </thead>
                <tbody>
                  {check.candidates.map((candidate, index) => (
                    <tr key={`${candidate.score}-${index}`}>
                      <td
                        className={`confidence ${candidate.score >= check.threshold ? 'medium' : 'ok'}`}
                      >
                        {formatPercent(candidate.score)}
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
