import React, { useEffect, useState } from 'react';
import { ApiError, MfaRequiredError, type ApiClient } from '../api/client';
import { ErrorBanner, Field } from '../components/ui';
import { useTranslator } from '../lib/locale';

/** Reads a reset token from `#/reset-password?token=…`, which is what the API hands out. */
function resetTokenFromHash(hash: string): string | null {
  const query = hash.split('?')[1] ?? '';
  return new URLSearchParams(query).get('token');
}

/** Opens a legal document published by the API, without leaving the app's state behind. */
function openLegal(slug: 'terms' | 'privacy'): void {
  if (typeof window === 'undefined') return;
  window.open(`${window.location.origin}/api/v1/legal/${slug}`, '_blank', 'noopener,noreferrer');
}

/**
 * Sign in, create the first account, or recover a password.
 *
 * The password rule is stated before submitting (12+ characters) rather than after a rejection,
 * and server errors are surfaced verbatim because they are already written for people.
 *
 * The API can deliver recovery links by SMTP. Outside production it also exposes a local-only
 * reset link so the flow can be tested without a mail server.
 */
export function LoginPage({
  client,
  onSignedIn,
  initialNotice,
}: {
  client: ApiClient;
  onSignedIn: () => void;
  initialNotice?: string | null;
}): React.JSX.Element {
  const initialHash = typeof window === 'undefined' ? '' : window.location.hash;
  const hashToken = resetTokenFromHash(initialHash);
  const [mode, setMode] = useState<'signin' | 'register' | 'forgot' | 'reset' | 'mfa'>(
    hashToken ? 'reset' : 'signin',
  );
  const [mfaCode, setMfaCode] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [organisationName, setOrganisationName] = useState('');
  const [token, setToken] = useState(hashToken ?? '');
  const [acceptedTerms, setAcceptedTerms] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(initialNotice ?? null);
  const [devResetUrl, setDevResetUrl] = useState<string | null>(null);
  const t = useTranslator();
  const [busy, setBusy] = useState(false);

  // Hash-only navigation does not reload the renderer. Handle a reset link opened while this
  // screen is already mounted as well as one present at initial startup.
  useEffect(() => {
    const onHashChange = () => {
      if (!window.location.hash.startsWith('#/reset-password?')) return;
      const issued = resetTokenFromHash(window.location.hash);
      if (!issued) return;
      setToken(issued);
      setPassword('');
      setError(null);
      setNotice(null);
      setMode('reset');
    };
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, []);

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
      } else if (mode === 'mfa') {
        await client.completeMfa(mfaCode.trim());
        onSignedIn();
      } else if (mode === 'register') {
        await client.register({
          email: email.trim(),
          password,
          displayName: displayName.trim() || email.split('@')[0] || 'Owner',
          organisationName: organisationName.trim(),
          acceptTerms: true,
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
        // Remove the used credential from the address bar and avoid reopening reset mode on reload.
        window.history.replaceState(
          null,
          '',
          `${window.location.pathname}${window.location.search}`,
        );
        setToken('');
        setDevResetUrl(null);
        setNotice(t('login.resetDone'));
        setPassword('');
        setMode('signin');
      }
    } catch (caught) {
      if (caught instanceof MfaRequiredError) {
        // Password accepted; ask for the second factor instead of pretending this failed.
        setPassword('');
        setMode('mfa');
        setNotice(null);
        return;
      }
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
              {mode === 'mfa' && t('login.mfaTitle')}
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

        {mode !== 'reset' && mode !== 'mfa' && (
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

        {mode === 'mfa' && (
          <Field label={t('login.mfaCode')} hint={t('login.mfaCodeHint')}>
            <input
              className="input"
              value={mfaCode}
              required
              autoComplete="one-time-code"
              inputMode="text"
              onChange={(event) => setMfaCode(event.target.value)}
            />
          </Field>
        )}

        {mode !== 'forgot' && mode !== 'mfa' && (
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
            {/*
              The acceptance is recorded server-side with the version that shipped (DEC-032). It is a
              deliberate click, not a footnote: a contract nobody agreed to is not a contract.
            */}
            <div className="stack" style={{ gap: 4 }}>
              <label className="row" style={{ gap: 8, alignItems: 'flex-start' }}>
                <input
                  type="checkbox"
                  checked={acceptedTerms}
                  required
                  onChange={(event) => setAcceptedTerms(event.target.checked)}
                />
                <span>{t('login.acceptTerms')}</span>
              </label>
              <div className="row" style={{ gap: 8 }}>
                <button
                  type="button"
                  className="link"
                  data-testid="terms-link"
                  onClick={() => openLegal('terms')}
                >
                  {t('login.termsLink')}
                </button>
                <button
                  type="button"
                  className="link"
                  data-testid="privacy-link"
                  onClick={() => openLegal('privacy')}
                >
                  {t('login.privacyLink')}
                </button>
              </div>
            </div>
          </>
        )}

        <button
          className="button"
          type="submit"
          disabled={
            busy ||
            (mode !== 'reset' && mode !== 'mfa' && !email) ||
            (mode !== 'forgot' && mode !== 'mfa' && !password) ||
            (mode === 'register' && !acceptedTerms) ||
            (mode === 'mfa' && !mfaCode.trim())
          }
        >
          {busy
            ? t('login.pleaseWait')
            : mode === 'mfa'
              ? t('login.verify')
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
