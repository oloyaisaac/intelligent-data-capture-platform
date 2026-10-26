import React, { useState } from 'react';
import type { ApiClient } from '../api/client';
import { Field } from '../components/ui';

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

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (password !== confirm) {
      setError('The two passwords do not match.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const pair = await client.acceptInvitation({ token, password });
      await client.adoptSession(pair);
      onAccepted();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'This invitation could not be accepted.');
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
            <div className="brand-name">Join your team</div>
            <div className="dim">Choose a password to finish setting up your account.</div>
          </div>
        </div>

        {error && (
          <div className="error-banner" role="alert">
            {error}
          </div>
        )}

        <Field label="Password" hint="At least 12 characters.">
          <input
            type="password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            autoComplete="new-password"
            minLength={12}
            required
          />
        </Field>
        <Field label="Confirm password">
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
          {busy ? 'Setting up…' : 'Set password and sign in'}
        </button>
        <p className="dim">
          This link works once. If it has expired, ask an administrator to send a new invitation.
        </p>
      </form>
    </div>
  );
}
