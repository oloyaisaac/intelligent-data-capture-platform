import React, { useState } from 'react';
import { ApiError, type ApiClient } from '../api/client';
import { ErrorBanner, Field } from '../components/ui';
import { useTranslator } from '../lib/locale';

/** Reads a reset token from `#/reset-password?token=…`, which is what the API hands out. */
function resetTokenFromHash(hash: string): string | null {
  const query = hash.split('?')[1] ?? '';
  return new URLSearchParams(query).get('token');
}

/**
 * Sign in, create the first account, or recover a password.
 *
 * The password rule is stated before submitting (12+ characters) rather than after a rejection,
 * and server errors are surfaced verbatim because they are already written for people.
 *
 * Recovery is honest about this deployment: the API sends no email, so outside production the
 * reset link is shown on screen instead of pretending a message went out.
 */
export function LoginPage({
  client,
  onSignedIn,
}: {
  client: ApiClient;
  onSignedIn: () => void;
}): React.JSX.Element {
  const initialHash = typeof window === 'undefined' ? '' : window.location.hash;
  const hashToken = resetTokenFromHash(initialHash);
  const [mode, setMode] = useState<'signin' | 'register' | 'forgot' | 'reset'>(
    hashToken ? 'reset' : 'signin',
  );
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [organisationName, setOrganisationName] = useState('');
  const [token, setToken] = useState(hashToken ?? '');
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [devResetUrl, setDevResetUrl] = useState<string | null>(null);
  const t = useTranslator();
  const [busy, setBusy] = useState(false);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      if (mode === 'signin') {
        await client.login({ email: email.trim(), password });
        onSignedIn();
      } else if (mode === 'register') {
        await client.register({
          email: email.trim(),
          password,
          displayName: displayName.trim() || email.split('@')[0] || 'Owner',
          organisationName: organisationName.trim(),
        });
        onSignedIn();
      } else if (mode === 'forgot') {
        const result = await client.forgotPassword(email.trim());
        setNotice(t('login.resetSent'));
        if (result.resetUrl) {
          const issued = resetTokenFromHash(result.resetUrl);
          setDevResetUrl(result.resetUrl);
          if (issued) setToken(issued);
        }
      } else {
        await client.resetPassword({ token: token.trim(), password });
        setNotice(t('login.resetDone'));
        setPassword('');
        setMode('signin');
      }
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
              {mode === 'signin' && t('login.title')}
              {mode === 'register' && t('login.registerTitle')}
              {mode === 'forgot' && t('login.forgotTitle')}
              {mode === 'reset' && t('login.resetTitle')}
            </h1>
            <p className="muted" style={{ margin: 0 }}>
              {t('app.tagline')}
            </p>
          </div>
        </div>

        <ErrorBanner message={error} />
        {notice && (
          <div className="muted" role="status" data-testid="login-notice">
            {notice}
          </div>
        )}
        {devResetUrl && (
          <div className="muted" style={{ wordBreak: 'break-all' }}>
            {t('login.devResetLink')}{' '}
            <a href={devResetUrl} data-testid="dev-reset-link">
              {devResetUrl}
            </a>
          </div>
        )}

        {mode !== 'reset' && (
          <Field
            label={t('auth.email')}
            hint={mode === 'forgot' ? t('login.forgotHint') : undefined}
          >
            <input
              className="input"
              type="email"
              value={email}
              autoComplete="email"
              required
              onChange={(event) => setEmail(event.target.value)}
            />
          </Field>
        )}

        {mode === 'reset' && (
          <Field label={t('login.resetCode')}>
            <input
              className="input"
              value={token}
              required
              autoComplete="one-time-code"
              onChange={(event) => setToken(event.target.value)}
            />
          </Field>
        )}

        {mode !== 'forgot' && (
          <Field
            label={mode === 'reset' ? t('account.newPassword') : t('auth.password')}
            hint={mode === 'signin' ? undefined : t('auth.passwordHint')}
          >
            <input
              className="input"
              type="password"
              value={password}
              autoComplete={mode === 'signin' ? 'current-password' : 'new-password'}
              minLength={mode === 'signin' ? undefined : 12}
              required
              onChange={(event) => setPassword(event.target.value)}
            />
          </Field>
        )}

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

        <button
          className="button"
          type="submit"
          disabled={busy || (mode !== 'reset' && !email) || (mode !== 'forgot' && !password)}
        >
          {busy
            ? t('login.pleaseWait')
            : mode === 'signin'
              ? t('action.signIn')
              : mode === 'register'
                ? t('action.register')
                : mode === 'forgot'
                  ? t('login.sendResetLink')
                  : t('login.setNewPassword')}
        </button>

        {mode === 'signin' && (
          <button
            type="button"
            className="button secondary"
            onClick={() => {
              setMode('forgot');
              setError(null);
              setNotice(null);
            }}
          >
            {t('login.forgotPassword')}
          </button>
        )}

        <button
          type="button"
          className="button secondary"
          onClick={() => {
            setMode(mode === 'signin' ? 'register' : 'signin');
            setError(null);
            setNotice(null);
            setDevResetUrl(null);
          }}
        >
          {mode === 'signin'
            ? t('login.switchToRegister')
            : mode === 'register'
              ? t('login.switchToSignin')
              : t('login.backToSignIn')}
        </button>
      </form>
    </div>
  );
}
