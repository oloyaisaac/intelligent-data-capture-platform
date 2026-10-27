import React, { useState } from 'react';
import { API_KEY_SCOPES, ROLES, type ApiKeyScope, type Locale } from '@idcp/shared';
import type { ApiClient } from '../api/client';
import { formatDateTime, formatPercent } from '../lib/format';
import { Badge, Card, EmptyState, ErrorBanner, Field, Modal, useAsync } from '../components/ui';
import { keyStatusLabel, roleLabel } from '../lib/labels';
import { useLocale, useTranslator } from '../lib/locale';

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
  const t = useTranslator();
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
  const { locale: activeLocale } = useLocale();
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [createdKey, setCreatedKey] = useState<{ key: string; name: string } | null>(null);
  const [keyName, setKeyName] = useState('');
  const [keyScopes, setKeyScopes] = useState<ApiKeyScope[]>(['documents:read']);
  const [keyDialog, setKeyDialog] = useState(false);
  const [filters, setFilters] = useState({ action: '', actor: '', from: '', to: '' });
  const [trainingNote, setTrainingNote] = useState<string | null>(null);
  const [auditNote, setAuditNote] = useState<string | null>(null);

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
      setNotice(t('settings.saved'));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : t('settings.couldNotSave'));
    }
  };

  return (
    <div className="stack">
      <h1>{t('settings.title')}</h1>

      {onLocaleChange && localeOptions.length > 0 && (
        <Card title={t('settings.languageCard')}>
          <div className="row" style={{ alignItems: 'flex-end' }}>
            <Field label={t('settings.interfaceLanguage')} hint={t('settings.languageHint')}>
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

      <Card title={t('settings.organisation')}>
        {organisation.data && (
          <div className="stack">
            <div className="row" style={{ gap: 24, flexWrap: 'wrap' }}>
              <div>
                <div className="label">{t('settings.name')}</div>
                <div>{organisation.data.name}</div>
              </div>
              <div>
                <div className="label">{t('settings.plan')}</div>
                <div>{organisation.data.plan}</div>
              </div>
              <div>
                <div className="label">{t('settings.retention')}</div>
                <div>{t('settings.days', { count: organisation.data.retentionDays })}</div>
              </div>
              <div>
                <div className="label">{t('settings.aiMode')}</div>
                <div>
                  {organisation.data.aiProvider === 'local'
                    ? t('settings.aiLocal')
                    : t('settings.aiCloud')}
                </div>
              </div>
            </div>

            {isAdmin && (
              <div className="toolbar">
                <Field label={t('settings.renameOrganisation')}>
                  <input
                    className="input"
                    value={name}
                    placeholder={organisation.data.name}
                    onChange={(event) => setName(event.target.value)}
                  />
                </Field>
                <Field label={t('settings.retentionDays')} hint={t('settings.retentionHint')}>
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
                  {t('settings.save')}
                </button>
                <button
                  className="button secondary"
                  type="button"
                  onClick={async () => {
                    setError(null);
                    try {
                      const result = await client.purgeRetention();
                      setNotice(t('settings.purgeComplete', { count: result.purged }));
                    } catch (caught) {
                      setError(
                        caught instanceof Error ? caught.message : t('settings.purgeFailed'),
                      );
                    }
                  }}
                >
                  {t('settings.purgeNow')}
                </button>
              </div>
            )}
            <p className="dim" style={{ margin: 0 }}>
              {t('settings.deleteNote')}
            </p>
          </div>
        )}
      </Card>

      <Card title={t('settings.correctionsCard')}>
        <div className="stack">
          <p className="dim" style={{ margin: 0 }}>
            {t('settings.correctionsNote')}
          </p>
          {corrections.data ? (
            <>
              <div className="row" style={{ gap: 24, flexWrap: 'wrap' }}>
                <div>
                  <div className="label">{t('settings.correctionsRecorded')}</div>
                  <div>{corrections.data.total}</div>
                </div>
                <div>
                  <div className="label">{t('settings.fieldsAffected')}</div>
                  <div>{corrections.data.byField.length}</div>
                </div>
                <div>
                  <div className="label">{t('settings.trainingUse')}</div>
                  <div>
                    {corrections.data.optIn ? t('settings.optedIn') : t('settings.notEnabled')}
                  </div>
                </div>
              </div>

              {corrections.data.byField.length > 0 && (
                <table className="table">
                  <thead>
                    <tr>
                      <th>{t('table.field')}</th>
                      <th>{t('table.corrections')}</th>
                      <th>{t('table.averageConfidence')}</th>
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
                            : formatPercent(row.averageConfidence, activeLocale)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}

              {isAdmin && (
                <div className="toolbar">
                  <Field
                    label={t('settings.useCorrections')}
                    hint={t('settings.useCorrectionsHint')}
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
                              ? t('settings.optInNote')
                              : t('settings.optOutNote'),
                          );
                        } catch (caught) {
                          setError(
                            caught instanceof Error
                              ? caught.message
                              : t('settings.couldNotSaveChoice'),
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
                        setTrainingNote(t('settings.exported', { count: result.rows.length }));
                      } catch (caught) {
                        setError(
                          caught instanceof Error ? caught.message : t('settings.exportFailed'),
                        );
                      }
                    }}
                  >
                    {t('settings.exportCorrections')}
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
              {t('settings.loadingCorrections')}
            </p>
          )}
        </div>
      </Card>

      <Card title={t('settings.team')}>
        <table className="table">
          <thead>
            <tr>
              <th>{t('settings.name')}</th>
              <th>{t('table.email')}</th>
              <th>{t('table.role')}</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {(users.data?.items ?? []).map((member) => (
              <tr key={member.id}>
                <td>{member.displayName}</td>
                <td className="dim">{member.email}</td>
                <td>
                  <Badge tone={member.role === 'owner' ? 'info' : 'neutral'}>
                    {roleLabel(t, member.role)}
                  </Badge>
                </td>
                <td style={{ textAlign: 'end' }}>
                  {isAdmin && member.role !== 'owner' && (
                    <select
                      className="select"
                      aria-label={t('settings.roleFor', { email: member.email })}
                      value={member.role}
                      onChange={async (event) => {
                        try {
                          await client.changeRole(member.id, event.target.value);
                          await users.reload();
                        } catch (caught) {
                          setError(
                            caught instanceof Error
                              ? caught.message
                              : t('settings.couldNotChangeRole'),
                          );
                        }
                      }}
                    >
                      {ROLES.filter((value) => value !== 'owner').map((value) => (
                        <option key={value} value={value}>
                          {roleLabel(t, value)}
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
            <Field label={t('settings.inviteByEmail')}>
              <input
                className="input"
                type="email"
                value={inviteEmail}
                onChange={(event) => setInviteEmail(event.target.value)}
              />
            </Field>
            <Field label={t('settings.role')}>
              <select
                className="select"
                value={inviteRole}
                onChange={(event) => setInviteRole(event.target.value)}
              >
                {ROLES.filter((value) => value !== 'owner').map((value) => (
                  <option key={value} value={value}>
                    {roleLabel(t, value)}
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
                  setNotice(t('settings.invitationReady'));
                  await users.reload();
                } catch (caught) {
                  setError(caught instanceof Error ? caught.message : t('settings.couldNotInvite'));
                }
              }}
            >
              {t('settings.sendInvitation')}
            </button>
          </div>
        )}

        {inviteLink && (
          <div className="notice" role="status">
            <div className="stack" style={{ gap: 4 }}>
              <strong>{t('settings.invitationLink')}</strong>
              <code className="mono" style={{ wordBreak: 'break-all' }}>
                {inviteLink}
              </code>
              <button
                className="button secondary small"
                type="button"
                onClick={() => {
                  void navigator.clipboard?.writeText(inviteLink);
                  setNotice(t('settings.linkCopied'));
                }}
              >
                {t('settings.copyLink')}
              </button>
            </div>
          </div>
        )}
      </Card>

      {isAdmin && (
        <Card
          title={t('settings.apiKeys')}
          actions={
            <button
              className="button secondary small"
              type="button"
              onClick={() => setKeyDialog(true)}
            >
              {t('settings.createKey')}
            </button>
          }
        >
          {(keys.data?.items.length ?? 0) === 0 ? (
            <EmptyState title={t('settings.noApiKeys')} hint={t('settings.noApiKeysHint')} />
          ) : (
            <table className="table">
              <thead>
                <tr>
                  <th>{t('settings.name')}</th>
                  <th>{t('table.prefix')}</th>
                  <th>{t('table.scopes')}</th>
                  <th>{t('table.lastUsed')}</th>
                  <th>{t('table.status')}</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {keys.data!.items.map((key) => (
                  <tr key={key.id}>
                    <td>{key.name}</td>
                    <td className="mono">{key.prefix}…</td>
                    <td className="dim">{key.scopes.join(', ')}</td>
                    <td className="dim">{formatDateTime(key.lastUsedAt ?? null, activeLocale)}</td>
                    <td>
                      <Badge tone={key.revokedAt ? 'danger' : 'success'}>
                        {keyStatusLabel(t, Boolean(key.revokedAt))}
                      </Badge>
                    </td>
                    <td style={{ textAlign: 'end' }}>
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
                                  : t('settings.couldNotRevoke'),
                              );
                            }
                          }}
                        >
                          {t('action.revoke')}
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

      <Card title={t('settings.auditTrail')}>
        <div className="toolbar">
          <Field label={t('filter.action')}>
            <input
              className="input"
              value={filters.action}
              placeholder="document.approved"
              onChange={(event) => setFilters({ ...filters, action: event.target.value })}
            />
          </Field>
          <Field label={t('filter.actorId')}>
            <input
              className="input mono"
              value={filters.actor}
              onChange={(event) => setFilters({ ...filters, actor: event.target.value })}
            />
          </Field>
          <Field label={t('filter.from')}>
            <input
              className="input"
              type="date"
              value={filters.from}
              onChange={(event) => setFilters({ ...filters, from: event.target.value })}
            />
          </Field>
          <Field label={t('filter.to')}>
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
                actorId: filters.actor || undefined,
                from: filters.from
                  ? new Date(`${filters.from}T00:00:00.000Z`).toISOString()
                  : undefined,
                to: filters.to ? new Date(`${filters.to}T23:59:59.999Z`).toISOString() : undefined,
                limit: 50,
              });
              audit.setData(result);
            }}
          >
            {t('settings.search')}
          </button>
          {/* The auditor's version of the button above: the same rows, as a file (DEC-032 note). */}
          <button
            className="button secondary"
            type="button"
            onClick={async () => {
              setAuditNote(null);
              try {
                const { blob, filename } = await client.auditLogCsv({
                  action: filters.action || undefined,
                  actorId: filters.actor || undefined,
                });
                const url = URL.createObjectURL(blob);
                const link = document.createElement('a');
                link.href = url;
                link.download = filename;
                link.click();
                URL.revokeObjectURL(url);
                setAuditNote(t('settings.auditExported'));
              } catch (caught) {
                setAuditNote(
                  caught instanceof Error ? caught.message : t('settings.auditExportFailed'),
                );
              }
            }}
          >
            {t('settings.exportAudit')}
          </button>
        </div>
        {auditNote && (
          <div className="muted" role="status">
            {auditNote}
          </div>
        )}

        {(audit.data?.items.length ?? 0) === 0 ? (
          <EmptyState title={t('settings.noMatchingRecords')} />
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>{t('table.when')}</th>
                <th>{t('filter.action')}</th>
                <th>{t('table.actor')}</th>
                <th>{t('table.target')}</th>
              </tr>
            </thead>
            <tbody>
              {audit.data!.items.map((entry) => (
                <tr key={entry.id}>
                  <td className="dim">{formatDateTime(entry.createdAt, activeLocale)}</td>
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
          {t('settings.auditNote')}
        </p>
      </Card>

      {keyDialog && (
        <Modal
          title={t('settings.createApiKey')}
          onClose={() => setKeyDialog(false)}
          footer={
            <>
              <button
                className="button secondary"
                type="button"
                onClick={() => setKeyDialog(false)}
              >
                {t('action.cancel')}
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
                      caught instanceof Error ? caught.message : t('settings.couldNotCreateKey'),
                    );
                  }
                }}
              >
                {t('settings.create')}
              </button>
            </>
          }
        >
          <Field label={t('settings.name')}>
            <input
              className="input"
              value={keyName}
              onChange={(event) => setKeyName(event.target.value)}
            />
          </Field>
          <div className="stack">
            <span className="label">{t('settings.scopes')}</span>
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
          title={t('settings.copyKeyNow')}
          onClose={() => setCreatedKey(null)}
          footer={
            <button className="button" type="button" onClick={() => setCreatedKey(null)}>
              {t('settings.copiedIt')}
            </button>
          }
        >
          <p className="muted" style={{ margin: 0 }}>
            {t('settings.keyShownOnce', { name: createdKey.name })}
          </p>
          <div className="code-block" data-testid="created-api-key">
            {createdKey.key}
          </div>
        </Modal>
      )}
    </div>
  );
}
