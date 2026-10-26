import React, { useState } from 'react';
import type { Connector, MappingProfile } from '@idcp/shared';
import type { ApiClient } from '../api/client';
import { formatDateTime } from '../lib/format';
import { Badge, Card, EmptyState, ErrorBanner, Field, useAsync } from '../components/ui';

/**
 * CON-001..003 / MAP-001 — connectors and field mappings.
 *
 * Credentials are write-only: the server never returns them, so the form is the only place they
 * exist outside the encrypted store. Testing a connector performs a real health check.
 */
export function ConnectorsPage({ client }: { client: ApiClient }): React.JSX.Element {
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
      setError('The config and credentials must be valid JSON.');
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
      setNotice('Connector saved. Run a test to confirm it can write.');
      await connectors.reload();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not save that connector.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="stack">
      <h1>Connectors</h1>
      <ErrorBanner message={error ?? connectors.error} />
      {notice && (
        <div className="notice" role="status">
          {notice}
        </div>
      )}

      <Card title="Add a connector">
        <div className="toolbar">
          <Field label="Type">
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
          <Field label="Name">
            <input
              className="input"
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="Finance drive"
            />
          </Field>
          <button
            className="button"
            type="button"
            onClick={() => void create()}
            disabled={busy || name.trim().length === 0}
          >
            Save connector
          </button>
        </div>
        <div className="split" style={{ marginTop: 12 }}>
          <Field label="Configuration (JSON)">
            <textarea
              className="textarea mono"
              rows={6}
              value={configText}
              onChange={(event) => setConfigText(event.target.value)}
            />
          </Field>
          <Field label="Credentials (write-only, encrypted at rest)">
            <textarea
              className="textarea mono"
              rows={6}
              value={credentialsText}
              onChange={(event) => setCredentialsText(event.target.value)}
            />
          </Field>
        </div>
      </Card>

      <Card title="Connected destinations">
        {connectors.data && connectors.data.items.length > 0 ? (
          <table className="table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Type</th>
                <th>Status</th>
                <th>Last checked</th>
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
                      {connector.status}
                    </Badge>
                  </td>
                  <td className="dim">{formatDateTime(connector.lastHealthCheckAt ?? null)}</td>
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
                                ? `${connector.name}: connection ok.`
                                : `${connector.name}: ${result.message ?? 'failed'}`,
                            );
                            await connectors.reload();
                          } catch (caught) {
                            setError(caught instanceof Error ? caught.message : 'Test failed.');
                          }
                        }}
                      >
                        Test
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <EmptyState
            title="No connectors yet"
            hint="Add a CSV, Google Sheets, SQLite or PostgreSQL destination."
          />
        )}
      </Card>

      <Card title="Mapping profiles">
        {profiles.data && profiles.data.items.length > 0 ? (
          <table className="table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Document type</th>
                <th>Fields</th>
                <th>Duplicates</th>
              </tr>
            </thead>
            <tbody>
              {profiles.data.items.map((profile: MappingProfile) => (
                <tr key={profile.id}>
                  <td>{profile.name}</td>
                  <td>{profile.documentType}</td>
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
          <EmptyState
            title="No mappings yet"
            hint="A mapping says which extracted field goes to which column."
          />
        )}
      </Card>
    </div>
  );
}
