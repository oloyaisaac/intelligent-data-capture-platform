import React, { useState } from 'react';
import type { Session } from '@idcp/shared';
import { ApiError, type ApiClient } from '../api/client';
import { Card, ErrorBanner, Field, useAsync } from '../components/ui';
import { formatDateTime } from '../lib/format';
import { useLocale, useTranslator } from '../lib/locale';

/**
 * Account: password, sessions, privacy and legal documents.
 *
 * Everything here is about one person, not one organisation, so it lives outside Settings (which is
 * mostly organisation configuration). The privacy section is the self-service half of
 * `legal/PRIVACY.md` §7: a data export and an erasure request that both work without asking anyone.
 */
const LEGAL_SLUGS = ['privacy', 'terms', 'dpa', 'subprocessors', 'security'] as const;

export function AccountPage({
  client,
  onSessionEnded,
}: {
  client: ApiClient;
  onSessionEnded: () => void;
}): React.JSX.Element {
  const t = useTranslator();
  const { locale } = useLocale();
  const sessions = useAsync(() => client.sessions(), []);
  // The acceptance record lives on the account, so it arrives with `/auth/me` (DEC-032).
  const me = useAsync(() => client.me(), []);
  const [termsNotice, setTermsNotice] = useState<string | null>(null);
  const [termsError, setTermsError] = useState<string | null>(null);

  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [passwordNotice, setPasswordNotice] = useState<string | null>(null);
  const [passwordError, setPasswordError] = useState<string | null>(null);
  const [passwordBusy, setPasswordBusy] = useState(false);

  const [privacyNotice, setPrivacyNotice] = useState<string | null>(null);
  const [privacyError, setPrivacyError] = useState<string | null>(null);
  const [confirmText, setConfirmText] = useState('');
  const [erasePassword, setErasePassword] = useState('');
  const [erasing, setErasing] = useState(false);

  const changePassword = async (event: React.FormEvent) => {
    event.preventDefault();
    if (passwordBusy) return;
    setPasswordBusy(true);
    setPasswordError(null);
    setPasswordNotice(null);
    try {
      const result = await client.changePassword({ currentPassword, newPassword });
      setPasswordNotice(
        t('account.passwordChanged').replace('{count}', String(result.revokedSessions)),
      );
      setCurrentPassword('');
      setNewPassword('');
      await sessions.reload();
    } catch (caught) {
      setPasswordError(caught instanceof ApiError ? caught.message : t('login.networkError'));
    } finally {
      setPasswordBusy(false);
    }
  };

  const downloadData = async () => {
    setPrivacyError(null);
    setPrivacyNotice(null);
    try {
      const data = await client.exportMyData();
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `idcp-my-data-${data.generatedAt.slice(0, 10)}.json`;
      link.click();
      URL.revokeObjectURL(url);
      setPrivacyNotice(t('account.dataDownloaded'));
    } catch (caught) {
      setPrivacyError(caught instanceof ApiError ? caught.message : t('login.networkError'));
    }
  };

  const erase = async (event: React.FormEvent) => {
    event.preventDefault();
    if (erasing || confirmText !== 'DELETE') return;
    setErasing(true);
    setPrivacyError(null);
    try {
      await client.eraseAccount({ password: erasePassword });
      setPrivacyNotice(t('account.erased'));
      // The session is gone with the account: send the shell back to the sign-in screen.
      onSessionEnded();
    } catch (caught) {
      setPrivacyError(caught instanceof ApiError ? caught.message : t('login.networkError'));
    } finally {
      setErasing(false);
    }
  };

  const revoke = async (session: Session) => {
    try {
      await client.revokeSession(session.id);
      await sessions.reload();
    } catch (caught) {
      setPasswordError(caught instanceof ApiError ? caught.message : t('login.networkError'));
    }
  };

  const signOutEverywhere = async () => {
    try {
      await client.logoutAll();
    } finally {
      onSessionEnded();
    }
  };

  const acceptTerms = async () => {
    setTermsError(null);
    setTermsNotice(null);
    try {
      await client.acceptTerms();
      setTermsNotice(t('account.termsAcceptedNow'));
      await me.reload();
    } catch (caught) {
      setTermsError(caught instanceof ApiError ? caught.message : t('login.networkError'));
    }
  };

  const openLegal = (slug: string) => {
    const base = typeof window === 'undefined' ? '' : window.location.origin;
    window.open(`${base}/api/v1/legal/${slug}`, '_blank', 'noopener,noreferrer');
  };

  return (
    <div className="stack" style={{ gap: 16 }}>
      <Card title={t('account.passwordTitle')}>
        <form className="stack" onSubmit={changePassword}>
          <ErrorBanner message={passwordError} />
          {passwordNotice && (
            <div className="muted" role="status">
              {passwordNotice}
            </div>
          )}
          <Field label={t('account.currentPassword')}>
            <input
              className="input"
              type="password"
              autoComplete="current-password"
              value={currentPassword}
              required
              onChange={(event) => setCurrentPassword(event.target.value)}
            />
          </Field>
          <Field label={t('account.newPassword')} hint={t('auth.passwordHint')}>
            <input
              className="input"
              type="password"
              autoComplete="new-password"
              minLength={12}
              value={newPassword}
              required
              onChange={(event) => setNewPassword(event.target.value)}
            />
          </Field>
          <div>
            <button
              className="button"
              type="submit"
              disabled={passwordBusy || !currentPassword || newPassword.length < 12}
            >
              {t('account.changePassword')}
            </button>
          </div>
        </form>
      </Card>

      <Card title={t('account.sessionsTitle')}>
        <p className="muted" style={{ marginTop: 0 }}>
          {t('account.sessionsHint')}
        </p>
        <ErrorBanner message={sessions.error} />
        {sessions.loading && <div className="muted">{t('login.pleaseWait')}</div>}
        {!sessions.loading && (sessions.data ?? []).length === 0 && (
          <div className="muted">{t('account.noSessions')}</div>
        )}
        <div className="stack" style={{ gap: 8 }}>
          {(sessions.data ?? []).map((session) => (
            <div
              key={session.id}
              className="row"
              style={{ justifyContent: 'space-between', gap: 12 }}
              data-testid="session-row"
            >
              <div>
                <div>{session.userAgent ?? t('account.thisDevice')}</div>
                <div className="dim">
                  {formatDateTime(session.createdAt, locale)} →{' '}
                  {formatDateTime(session.expiresAt, locale)}
                  {session.current ? ` · ${t('account.thisDevice')}` : ''}
                </div>
              </div>
              <button
                className="button secondary small"
                type="button"
                onClick={() => revoke(session)}
              >
                {t('account.revoke')}
              </button>
            </div>
          ))}
        </div>
        <div style={{ marginTop: 12 }}>
          <button className="button secondary" type="button" onClick={signOutEverywhere}>
            {t('account.signOutEverywhere')}
          </button>
        </div>
      </Card>

      <Card title={t('account.privacyTitle')}>
        <p className="muted" style={{ marginTop: 0 }}>
          {t('account.privacyHint')}
        </p>
        <ErrorBanner message={privacyError} />
        {privacyNotice && (
          <div className="muted" role="status">
            {privacyNotice}
          </div>
        )}
        <div className="row" style={{ gap: 8 }}>
          <button className="button secondary" type="button" onClick={downloadData}>
            {t('account.downloadData')}
          </button>
        </div>

        <form className="stack" onSubmit={erase} style={{ marginTop: 16 }}>
          <strong>{t('account.eraseTitle')}</strong>
          <p className="muted" style={{ margin: 0 }}>
            {t('account.eraseHint')}
          </p>
          <Field label={t('account.eraseConfirm')}>
            <input
              className="input"
              value={confirmText}
              onChange={(event) => setConfirmText(event.target.value)}
            />
          </Field>
          <Field label={t('auth.password')}>
            <input
              className="input"
              type="password"
              autoComplete="current-password"
              value={erasePassword}
              onChange={(event) => setErasePassword(event.target.value)}
            />
          </Field>
          <div>
            <button
              className="button secondary"
              type="submit"
              disabled={erasing || confirmText !== 'DELETE' || !erasePassword}
            >
              {t('account.eraseAction')}
            </button>
          </div>
        </form>
      </Card>

      <Card title={t('account.termsTitle')}>
        <ErrorBanner message={termsError} />
        {termsNotice && (
          <div className="muted" role="status">
            {termsNotice}
          </div>
        )}
        {me.data?.terms && (
          <>
            <p className="muted" style={{ marginTop: 0 }}>
              {me.data.terms.acceptedAt
                ? t('account.termsAccepted', {
                    version: me.data.terms.version ?? '—',
                    date: formatDateTime(me.data.terms.acceptedAt, locale),
                  })
                : t('account.termsMissing')}
            </p>
            {!me.data.terms.current && (
              <>
                {me.data.terms.acceptedAt && (
                  <p className="muted">
                    {t('account.termsOutdated', { version: me.data.terms.version ?? '—' })}
                  </p>
                )}
                <button className="button" type="button" onClick={acceptTerms}>
                  {t('account.acceptTerms')}
                </button>
              </>
            )}
          </>
        )}
      </Card>

      <Card title={t('account.legalTitle')}>
        <p className="muted" style={{ marginTop: 0 }}>
          {t('account.legalHint')}
        </p>
        <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
          {LEGAL_SLUGS.map((slug) => (
            <button
              key={slug}
              className="button secondary small"
              type="button"
              onClick={() => openLegal(slug)}
            >
              {slug}
            </button>
          ))}
        </div>
      </Card>
    </div>
  );
}
