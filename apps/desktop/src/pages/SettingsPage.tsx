import React, { useState } from 'react';
import { API_KEY_SCOPES, ROLES, type ApiKeyScope, type Locale } from '@idcp/shared';
import type { ApiClient } from '../api/client';
import { formatDateTime, formatPercent } from '../lib/format';
import { Badge, Card, EmptyState, ErrorBanner, Field, Modal, useAsync } from '../components/ui';

/**
 * TEAM-001 / AUDIT-001 / SEC-001 / DEVAPI-001 — organisation settings, team, audit trail,
 * retention and API keys, in one place because they are the same job: keeping the workspace
 * explainable and closed to the wrong people.
 */
export function SettingsPage({
  client,
  role,
  locale = 'en',
  localeOptions = [],
  onLocaleChange,
}: {
  client: ApiClient;
  role: string;
  locale?: Locale;
  localeOptions?: Array<{ locale: Locale; label: string }>;
  onLocaleChange?: (locale: Locale) => void;
}): React.JSX.Element {
  const organisation = useAsync(() => client.organisation(), []);
  const users = useAsync(() => client.listUsers(), []);
  const audit = useAsync(() => client.auditLogs({ limit: 50 }), []);
  const keys = useAsync(() => client.listApiKeys(), []);
  const corrections = useAsync(() => client.correctionStats(), []);

  const [name, setName] = useState('');
  const [retentionDays, setRetentionDays] = useState<number | ''>('');
  const [inviteEmail, setInviteEmail] = useState('');
  const [inviteRole, setInviteRole] = useState('reviewer');
  const [inviteLink, setInviteLink] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [createdKey, setCreatedKey] = useState<{ key: string; name: string } | null>(null);
  const [keyName, setKeyName] = useState('');
  const [keyScopes, setKeyScopes] = useState<ApiKeyScope[]>(['documents:read']);
  const [keyDialog, setKeyDialog] = useState(false);
  const [filters, setFilters] = useState({ action: '', actor: '', from: '', to: '' });
  const [trainingNote, setTrainingNote] = useState<string | null>(null);

  const isAdmin = role === 'admin' || role === 'owner';

  const saveOrganisation = async () => {
    setError(null);
    setNotice(null);
    try {
      const updated = await client.updateOrganisation({
        ...(name.trim() ? { name: name.trim() } : {}),
        ...(retentionDays !== '' ? { retentionDays: Number(retentionDays) } : {}),
      });
      organisation.setData(updated);
      setName('');
      setRetentionDays('');
      setNotice('Organisation settings saved.');
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not save those settings.');
    }
  };

  return (
    <div className="stack">
      <h1>Settings</h1>

      {onLocaleChange && localeOptions.length > 0 && (
        <Card title="Language">
          <div className="row" style={{ alignItems: 'flex-end' }}>
            <Field
              label="Interface language"
              hint="Missing translations fall back to English; the choice is remembered on this device."
            >
              <select
                className="select"
                value={locale}
                onChange={(event) => onLocaleChange(event.target.value as Locale)}
              >
                {localeOptions.map((option) => (
                  <option key={option.locale} value={option.locale}>
                    {option.label}
                  </option>
                ))}
              </select>
            </Field>
          </div>
        </Card>
      )}
      <ErrorBanner message={error} />
      {notice && (
        <div className="notice" role="status">
          {notice}
        </div>
      )}

      <Card title="Organisation">
        {organisation.data && (
          <div className="stack">
            <div className="row" style={{ gap: 24, flexWrap: 'wrap' }}>
              <div>
                <div className="label">Name</div>
                <div>{organisation.data.name}</div>
              </div>
              <div>
                <div className="label">Plan</div>
                <div>{organisation.data.plan}</div>
              </div>
              <div>
                <div className="label">Retention</div>
                <div>{organisation.data.retentionDays} days</div>
              </div>
              <div>
                <div className="label">AI mode</div>
                <div>
                  {organisation.data.aiProvider === 'local' ? 'On this machine' : 'Cloud provider'}
                </div>
              </div>
            </div>

            {isAdmin && (
              <div className="toolbar">
                <Field label="Rename organisation">
                  <input
                    className="input"
                    value={name}
                    placeholder={organisation.data.name}
                    onChange={(event) => setName(event.target.value)}
                  />
                </Field>
                <Field label="Retention (days)" hint="0 keeps documents until deleted by hand.">
                  <input
                    className="input"
                    type="number"
                    min={0}
                    max={3650}
                    value={retentionDays}
                    onChange={(event) =>
                      setRetentionDays(event.target.value === '' ? '' : Number(event.target.value))
                    }
                  />
                </Field>
                <button className="button" type="button" onClick={() => void saveOrganisation()}>
                  Save
                </button>
                <button
                  className="button secondary"
                  type="button"
                  onClick={async () => {
                    setError(null);
                    try {
                      const result = await client.purgeRetention();
                      setNotice(`Purge complete: ${result.purged} document(s) removed.`);
                    } catch (caught) {
                      setError(caught instanceof Error ? caught.message : 'Purge failed.');
                    }
                  }}
                >
                  Run retention purge now
                </button>
              </div>
            )}
            <p className="dim" style={{ margin: 0 }}>
              Deleting a document removes the stored file, not only its metadata, and the purge is
              recorded in the audit trail.
            </p>
          </div>
        )}
      </Card>

      <Card title="Corrections and learning">
        <div className="stack">
          <p className="dim" style={{ margin: 0 }}>
            Every field a reviewer changes is kept as a correction. The aggregates below show which
            fields keep needing attention; the values themselves stay in the record.
          </p>
          {corrections.data ? (
            <>
              <div className="row" style={{ gap: 24, flexWrap: 'wrap' }}>
                <div>
                  <div className="label">Corrections recorded</div>
                  <div>{corrections.data.total}</div>
                </div>
                <div>
                  <div className="label">Fields affected</div>
                  <div>{corrections.data.byField.length}</div>
                </div>
                <div>
                  <div className="label">Training use</div>
                  <div>{corrections.data.optIn ? 'Opted in' : 'Not enabled'}</div>
                </div>
              </div>

              {corrections.data.byField.length > 0 && (
                <table className="table">
                  <thead>
                    <tr>
                      <th>Field</th>
                      <th>Corrections</th>
                      <th>Average confidence</th>
                    </tr>
                  </thead>
                  <tbody>
                    {corrections.data.byField.slice(0, 8).map((row) => (
                      <tr key={row.fieldPath}>
                        <td>{row.fieldPath}</td>
                        <td>{row.corrections}</td>
                        <td className="dim">
                          {row.averageConfidence === null
                            ? '—'
                            : formatPercent(row.averageConfidence)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}

              {isAdmin && (
                <div className="toolbar">
                  <Field
                    label="Use corrections to improve extraction"
                    hint="Off by default: your documents are yours unless you say otherwise."
                  >
                    <input
                      type="checkbox"
                      checked={corrections.data.optIn}
                      onChange={async (event) => {
                        setError(null);
                        setTrainingNote(null);
                        try {
                          const updated = await client.updateOrganisation({
                            learningOptIn: event.target.checked,
                          });
                          organisation.setData(updated);
                          await corrections.reload();
                          setTrainingNote(
                            event.target.checked
                              ? 'Opted in. Corrections can now be exported for training.'
                              : 'Opted out. Corrections stay out of training.',
                          );
                        } catch (caught) {
                          setError(
                            caught instanceof Error
                              ? caught.message
                              : 'Could not save that choice.',
                          );
                        }
                      }}
                    />
                  </Field>
                  <button
                    className="button secondary"
                    type="button"
                    disabled={!corrections.data.optIn}
                    onClick={async () => {
                      setError(null);
                      setTrainingNote(null);
                      try {
                        const result = await client.exportCorrections();
                        setTrainingNote(`Exported ${result.rows.length} correction(s).`);
                      } catch (caught) {
                        setError(caught instanceof Error ? caught.message : 'Export failed.');
                      }
                    }}
                  >
                    Export corrections
                  </button>
                </div>
              )}
              {trainingNote && (
                <p className="dim" style={{ margin: 0 }}>
                  {trainingNote}
                </p>
              )}
            </>
          ) : (
            <p className="dim" style={{ margin: 0 }}>
              Loading correction statistics…
            </p>
          )}
        </div>
      </Card>

      <Card title="Team">
        <table className="table">
          <thead>
            <tr>
              <th>Name</th>
              <th>Email</th>
              <th>Role</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {(users.data?.items ?? []).map((member) => (
              <tr key={member.id}>
                <td>{member.displayName}</td>
                <td className="dim">{member.email}</td>
                <td>
                  <Badge tone={member.role === 'owner' ? 'info' : 'neutral'}>{member.role}</Badge>
                </td>
                <td style={{ textAlign: 'right' }}>
                  {isAdmin && member.role !== 'owner' && (
                    <select
                      className="select"
                      aria-label={`Role for ${member.email}`}
                      value={member.role}
                      onChange={async (event) => {
                        try {
                          await client.changeRole(member.id, event.target.value);
                          await users.reload();
                        } catch (caught) {
                          setError(
                            caught instanceof Error
                              ? caught.message
                              : 'Could not change that role.',
                          );
                        }
                      }}
                    >
                      {ROLES.filter((value) => value !== 'owner').map((value) => (
                        <option key={value} value={value}>
                          {value}
                        </option>
                      ))}
                    </select>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>

        {isAdmin && (
          <div className="toolbar" style={{ marginTop: 12 }}>
            <Field label="Invite by email">
              <input
                className="input"
                type="email"
                value={inviteEmail}
                onChange={(event) => setInviteEmail(event.target.value)}
              />
            </Field>
            <Field label="Role">
              <select
                className="select"
                value={inviteRole}
                onChange={(event) => setInviteRole(event.target.value)}
              >
                {ROLES.filter((value) => value !== 'owner').map((value) => (
                  <option key={value} value={value}>
                    {value}
                  </option>
                ))}
              </select>
            </Field>
            <button
              className="button"
              type="button"
              disabled={inviteEmail.trim().length === 0}
              onClick={async () => {
                setError(null);
                try {
                  const { invitation } = await client.inviteUser({
                    email: inviteEmail.trim(),
                    role: inviteRole,
                  });
                  setInviteEmail('');
                  // No email delivery is configured, so the link is shown once, for the admin to pass on.
                  setInviteLink(invitation.acceptUrl);
                  setNotice('Invitation ready. Share the link — it expires and works once.');
                  await users.reload();
                } catch (caught) {
                  setError(
                    caught instanceof Error ? caught.message : 'Could not send that invitation.',
                  );
                }
              }}
            >
              Send invitation
            </button>
          </div>
        )}

        {inviteLink && (
          <div className="notice" role="status">
            <div className="stack" style={{ gap: 4 }}>
              <strong>Invitation link</strong>
              <code className="mono" style={{ wordBreak: 'break-all' }}>
                {inviteLink}
              </code>
              <button
                className="button secondary small"
                type="button"
                onClick={() => {
                  void navigator.clipboard?.writeText(inviteLink);
                  setNotice('Link copied.');
                }}
              >
                Copy link
              </button>
            </div>
          </div>
        )}
      </Card>

      {isAdmin && (
        <Card
          title="API keys"
          actions={
            <button
              className="button secondary small"
              type="button"
              onClick={() => setKeyDialog(true)}
            >
              Create key
            </button>
          }
        >
          {(keys.data?.items.length ?? 0) === 0 ? (
            <EmptyState
              title="No API keys"
              hint="Keys are for scheduled exports and integrations."
            />
          ) : (
            <table className="table">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Prefix</th>
                  <th>Scopes</th>
                  <th>Last used</th>
                  <th>Status</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {keys.data!.items.map((key) => (
                  <tr key={key.id}>
                    <td>{key.name}</td>
                    <td className="mono">{key.prefix}…</td>
                    <td className="dim">{key.scopes.join(', ')}</td>
                    <td className="dim">{formatDateTime(key.lastUsedAt ?? null)}</td>
                    <td>
                      <Badge tone={key.revokedAt ? 'danger' : 'success'}>
                        {key.revokedAt ? 'revoked' : 'active'}
                      </Badge>
                    </td>
                    <td style={{ textAlign: 'right' }}>
                      {!key.revokedAt && (
                        <button
                          className="button danger small"
                          type="button"
                          onClick={async () => {
                            try {
                              await client.revokeApiKey(key.id);
                              await keys.reload();
                            } catch (caught) {
                              setError(
                                caught instanceof Error
                                  ? caught.message
                                  : 'Could not revoke that key.',
                              );
                            }
                          }}
                        >
                          Revoke
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>
      )}

      <Card title="Audit trail">
        <div className="toolbar">
          <Field label="Action">
            <input
              className="input"
              value={filters.action}
              placeholder="document.approved"
              onChange={(event) => setFilters({ ...filters, action: event.target.value })}
            />
          </Field>
          <Field label="Actor id">
            <input
              className="input mono"
              value={filters.actor}
              onChange={(event) => setFilters({ ...filters, actor: event.target.value })}
            />
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
            onClick={async () => {
              const result = await client.auditLogs({
                action: filters.action || undefined,
                actor: filters.actor || undefined,
                from: filters.from
                  ? new Date(`${filters.from}T00:00:00.000Z`).toISOString()
                  : undefined,
                to: filters.to ? new Date(`${filters.to}T23:59:59.999Z`).toISOString() : undefined,
                limit: 50,
              });
              audit.setData(result);
            }}
          >
            Search
          </button>
        </div>

        {(audit.data?.items.length ?? 0) === 0 ? (
          <EmptyState title="No matching records" />
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>When</th>
                <th>Action</th>
                <th>Actor</th>
                <th>Target</th>
              </tr>
            </thead>
            <tbody>
              {audit.data!.items.map((entry) => (
                <tr key={entry.id}>
                  <td className="dim">{formatDateTime(entry.createdAt)}</td>
                  <td className="mono">{entry.action}</td>
                  <td className="dim">
                    {entry.actorType}
                    {entry.actorId ? ` · ${entry.actorId.slice(0, 8)}` : ''}
                  </td>
                  <td className="dim">
                    {entry.targetType ?? '—'}
                    {entry.targetId ? ` · ${entry.targetId.slice(0, 8)}` : ''}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <p className="dim" style={{ marginBottom: 0 }}>
          Audit records are append-only: the database rejects updates and deletes.
        </p>
      </Card>

      {keyDialog && (
        <Modal
          title="Create an API key"
          onClose={() => setKeyDialog(false)}
          footer={
            <>
              <button
                className="button secondary"
                type="button"
                onClick={() => setKeyDialog(false)}
              >
                Cancel
              </button>
              <button
                className="button"
                type="button"
                disabled={keyName.trim().length === 0 || keyScopes.length === 0}
                onClick={async () => {
                  setError(null);
                  try {
                    const created = await client.createApiKey({
                      name: keyName.trim(),
                      scopes: keyScopes,
                    });
                    setCreatedKey({ key: created.key, name: created.name });
                    setKeyDialog(false);
                    setKeyName('');
                    setKeyScopes(['documents:read']);
                    await keys.reload();
                  } catch (caught) {
                    setError(
                      caught instanceof Error ? caught.message : 'Could not create that key.',
                    );
                  }
                }}
              >
                Create
              </button>
            </>
          }
        >
          <Field label="Name">
            <input
              className="input"
              value={keyName}
              onChange={(event) => setKeyName(event.target.value)}
            />
          </Field>
          <div className="stack">
            <span className="label">Scopes</span>
            {API_KEY_SCOPES.map((scope) => (
              <label className="row" key={scope} style={{ gap: 8 }}>
                <input
                  type="checkbox"
                  checked={keyScopes.includes(scope)}
                  onChange={(event) =>
                    setKeyScopes(
                      event.target.checked
                        ? [...keyScopes, scope]
                        : keyScopes.filter((value) => value !== scope),
                    )
                  }
                />
                <span className="mono">{scope}</span>
              </label>
            ))}
          </div>
        </Modal>
      )}

      {createdKey && (
        <Modal
          title="Copy this key now"
          onClose={() => setCreatedKey(null)}
          footer={
            <button className="button" type="button" onClick={() => setCreatedKey(null)}>
              I have copied it
            </button>
          }
        >
          <p className="muted" style={{ margin: 0 }}>
            This is the only time the key for “{createdKey.name}” is shown. Store it somewhere safe.
          </p>
          <div className="code-block" data-testid="created-api-key">
            {createdKey.key}
          </div>
        </Modal>
      )}
    </div>
  );
}
