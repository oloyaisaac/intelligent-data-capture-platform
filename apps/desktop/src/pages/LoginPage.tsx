import React, { useState } from 'react';
import { ApiError, type ApiClient } from '../api/client';
import { ErrorBanner, Field } from '../components/ui';
import { useTranslator } from '../lib/locale';

/**
 * Sign in / create the first account.
 *
 * The password rule is stated before submitting (12+ characters) rather than after a rejection,
 * and server errors are surfaced verbatim because they are already written for people.
 */
export function LoginPage({
  client,
  onSignedIn,
}: {
  client: ApiClient;
  onSignedIn: () => void;
}): React.JSX.Element {
  const [mode, setMode] = useState<'signin' | 'register'>('signin');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [organisationName, setOrganisationName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const t = useTranslator();
  const [busy, setBusy] = useState(false);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      if (mode === 'signin') {
        await client.login({ email: email.trim(), password });
      } else {
        await client.register({
          email: email.trim(),
          password,
          displayName: displayName.trim() || email.split('@')[0] || 'Owner',
          organisationName: organisationName.trim(),
        });
      }
      onSignedIn();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : t('login.networkError'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="login-shell">
      <form
        className="login-card card"
        onSubmit={submit}
        aria-label={mode === 'signin' ? t('action.signIn') : t('action.register')}
      >
        <div className="row">
          <div className="brand-mark" aria-hidden="true">
            ID
          </div>
          <div>
            <h1 className="login-title">
              {mode === 'signin' ? t('login.title') : t('login.registerTitle')}
            </h1>
            <p className="muted" style={{ margin: 0 }}>
              {t('app.tagline')}
            </p>
          </div>
        </div>

        <ErrorBanner message={error} />

        <Field label={t('auth.email')}>
          <input
            className="input"
            type="email"
            value={email}
            autoComplete="email"
            required
            onChange={(event) => setEmail(event.target.value)}
          />
        </Field>

        <Field
          label={t('auth.password')}
          hint={mode === 'register' ? t('auth.passwordHint') : undefined}
        >
          <input
            className="input"
            type="password"
            value={password}
            autoComplete={mode === 'signin' ? 'current-password' : 'new-password'}
            minLength={mode === 'register' ? 12 : undefined}
            required
            onChange={(event) => setPassword(event.target.value)}
          />
        </Field>

        {mode === 'register' && (
          <>
            <Field label={t('auth.yourName')}>
              <input
                className="input"
                value={displayName}
                autoComplete="name"
                onChange={(event) => setDisplayName(event.target.value)}
              />
            </Field>
            <Field label={t('auth.organisation')} hint={t('auth.organisationHint')}>
              <input
                className="input"
                value={organisationName}
                minLength={2}
                required
                onChange={(event) => setOrganisationName(event.target.value)}
              />
            </Field>
          </>
        )}

        <button className="button" type="submit" disabled={busy || !email || !password}>
          {busy
            ? t('login.pleaseWait')
            : mode === 'signin'
              ? t('action.signIn')
              : t('action.register')}
        </button>

        <button
          type="button"
          className="button secondary"
          onClick={() => {
            setMode(mode === 'signin' ? 'register' : 'signin');
            setError(null);
          }}
        >
          {mode === 'signin' ? t('login.switchToRegister') : t('login.switchToSignin')}
        </button>
      </form>
    </div>
  );
}
