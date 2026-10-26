import React, { useState } from 'react';
import type { ApiClient } from '../api/client';
import { Field } from '../components/ui';
import { useTranslator } from '../lib/locale';

/**
 * TEAM-001 — the screen an invitation link opens.
 *
 * The token in the URL is the credential, so this renders before sign-in. Setting a password here
 * consumes the link (single use) and signs the person in, which is the shortest honest path for an
 * invited colleague.
 */
export function AcceptInvitePage({
  client,
  token,
  onAccepted,
}: {
  client: ApiClient;
  token: string;
  onAccepted: () => void;
}): React.JSX.Element {
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const t = useTranslator();

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (password !== confirm) {
      setError(t('invite.mismatch'));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const pair = await client.acceptInvitation({ token, password });
      await client.adoptSession(pair);
      onAccepted();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : t('invite.failed'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="login-shell">
      <form className="login-card stack" onSubmit={(event) => void submit(event)}>
        <div className="brand">
          <div className="brand-mark" aria-hidden="true">
            ID
          </div>
          <div>
            <div className="brand-name">{t('invite.title')}</div>
            <div className="dim">{t('invite.subtitle')}</div>
          </div>
        </div>

        {error && (
          <div className="error-banner" role="alert">
            {error}
          </div>
        )}

        <Field label={t('auth.password')} hint={t('auth.passwordHint')}>
          <input
            type="password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            autoComplete="new-password"
            minLength={12}
            required
          />
        </Field>
        <Field label={t('auth.confirmPassword')}>
          <input
            type="password"
            value={confirm}
            onChange={(event) => setConfirm(event.target.value)}
            autoComplete="new-password"
            minLength={12}
            required
          />
        </Field>

        <button className="button" type="submit" disabled={busy || password.length < 12}>
          {busy ? t('invite.settingUp') : t('invite.submit')}
        </button>
        <p className="dim">{t('invite.singleUse')}</p>
      </form>
    </div>
  );
}
