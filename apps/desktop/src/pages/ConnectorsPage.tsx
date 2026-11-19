import React, { useState } from 'react';
import type { Connector, MappingProfile } from '@idcp/shared';
import type { ApiClient } from '../api/client';
import { formatDateTime } from '../lib/format';
import { Badge, Card, EmptyState, ErrorBanner, Field, useAsync } from '../components/ui';
import { useLocale, useTranslator } from '../lib/locale';
import { documentTypeLabel } from '../lib/labels';

/**
 * CON-001..003 / MAP-001 — connectors and field mappings.
 *
 * New connector configuration and credentials are write-only and encrypted at rest. Legacy rows
 * require offline migration, and credentials can also exist in backups or connector processes.
 * Testing a connector performs a real health check.
 */
export function ConnectorsPage({ client }: { client: ApiClient }): React.JSX.Element {
  const t = useTranslator();
  const { locale } = useLocale();
  const connectors = useAsync(() => client.listConnectors(), []);
  const types = useAsync(() => client.connectorTypes(), []);
  const profiles = useAsync(() => client.listMappingProfiles(), []);

  const [name, setName] = useState('');
  const [type, setType] = useState('csv');
  const [configText, setConfigText] = useState('{\n  "path": "/exports/records.csv"\n}');
  const [credentialsText, setCredentialsText] = useState('{}');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const create = async () => {
    setError(null);
    setNotice(null);
    let config: unknown;
    let credentials: Record<string, string> | undefined;
    try {
      config = JSON.parse(configText) as Record<string, unknown>;
      const parsedCredentials = JSON.parse(credentialsText) as Record<string, string>;
      credentials = Object.keys(parsedCredentials).length > 0 ? parsedCredentials : undefined;
    } catch {
      setError(t('connectors.badJson'));
      return;
    }

    setBusy(true);
    try {
      await client.createConnector({
        type: type as Connector['type'] & 'csv',
        name,
        config: config as Record<string, unknown>,
        credentials,
      });
      setName('');
      setCredentialsText('{}');
      setNotice(t('connectors.saved'));
      await connectors.reload();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : t('connectors.saveFailed'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="stack">
      <h1>{t('connectors.title')}</h1>
      <ErrorBanner message={error ?? connectors.error} />
      {notice && (
        <div className="notice" role="status">
          {notice}
        </div>
      )}

      <Card title={t('connectors.add')}>
        <div className="toolbar">
          <Field label={t('connectors.type')}>
            <select
              className="select"
              value={type}
              onChange={(event) => setType(event.target.value)}
            >
              {(types.data?.items ?? [{ type: 'csv', label: 'CSV file', capabilities: [] }]).map(
                (entry) => (
                  <option key={entry.type} value={entry.type}>
                    {entry.label}
                  </option>
                ),
              )}
            </select>
          </Field>
          <Field label={t('connectors.name')}>
            <input
              className="input"
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder={t('connectors.namePlaceholder')}
            />
          </Field>
          <button
            className="button"
            type="button"
            onClick={() => void create()}
            disabled={busy || name.trim().length === 0}
          >
            {t('connectors.save')}
          </button>
        </div>
        <div className="split" style={{ marginTop: 12 }}>
          <Field label={t('connectors.configuration')}>
            <textarea
              className="textarea mono"
              rows={6}
              value={configText}
              onChange={(event) => setConfigText(event.target.value)}
            />
          </Field>
          <Field label={t('connectors.credentials')}>
            <textarea
              className="textarea mono"
              rows={6}
              value={credentialsText}
              onChange={(event) => setCredentialsText(event.target.value)}
            />
          </Field>
        </div>
      </Card>

      <Card title={t('connectors.connected')}>
        {connectors.data && connectors.data.items.length > 0 ? (
          <table className="table">
            <thead>
              <tr>
                <th>{t('connectors.name')}</th>
                <th>{t('table.type')}</th>
                <th>{t('table.status')}</th>
                <th>{t('table.lastChecked')}</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {connectors.data.items.map((connector) => (
                <tr key={connector.id}>
                  <td>{connector.name}</td>
                  <td className="mono">{connector.type}</td>
                  <td>
                    <Badge
                      tone={
                        connector.status === 'active'
                          ? 'success'
                          : connector.status === 'error'
                            ? 'danger'
                            : 'neutral'
                      }
                    >
                      {connector.status === 'active' ? t('status.active') : connector.status}
                    </Badge>
                  </td>
                  <td className="dim">
                    {formatDateTime(connector.lastHealthCheckAt ?? null, locale)}
                  </td>
                  <td>
                    <div className="row" style={{ justifyContent: 'flex-end' }}>
                      <button
                        className="button secondary small"
                        type="button"
                        onClick={async () => {
                          setError(null);
                          try {
                            const result = await client.testConnector(connector.id);
                            setNotice(
                              result.ok
                                ? t('connectors.testOk', { name: connector.name })
                                : t('connectors.testFailedFor', {
                                    name: connector.name,
                                    message: result.message ?? t('connectors.failedWord'),
                                  }),
                            );
                            await connectors.reload();
                          } catch (caught) {
                            setError(
                              caught instanceof Error ? caught.message : t('connectors.testFailed'),
                            );
                          }
                        }}
                      >
                        {t('connectors.test')}
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <EmptyState title={t('connectors.none')} hint={t('connectors.noneHint')} />
        )}
      </Card>

      <Card title={t('connectors.mappings')}>
        {profiles.data && profiles.data.items.length > 0 ? (
          <table className="table">
            <thead>
              <tr>
                <th>{t('connectors.name')}</th>
                <th>{t('filter.documentType')}</th>
                <th>{t('table.fields')}</th>
                <th>{t('table.duplicates')}</th>
              </tr>
            </thead>
            <tbody>
              {profiles.data.items.map((profile: MappingProfile) => (
                <tr key={profile.id}>
                  <td>{profile.name}</td>
                  <td>{documentTypeLabel(t, profile.documentType)}</td>
                  <td>{profile.fieldMap.length}</td>
                  <td className="dim">
                    {profile.duplicatePolicy}
                    {profile.duplicateKeys.length > 0
                      ? ` on ${profile.duplicateKeys.join(', ')}`
                      : ''}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <EmptyState title={t('connectors.noMappings')} hint={t('connectors.noMappingsHint')} />
        )}
      </Card>
    </div>
  );
}
