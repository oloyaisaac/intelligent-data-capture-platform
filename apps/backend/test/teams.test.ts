import { createHarness, registerAccount, type Harness } from './helpers';
import { AuditRepository } from '../src/repositories/system-repo';
import { totp } from '../src/auth/totp';

/**
 * TEAM-001 — projects and expiring single-use invitations.
 *
 * Invitations are security-sensitive: the token is the only credential, so the tests check that
 * it is stored hashed, expires, and cannot be used twice.
 */
describe('TEAM-001 teams, projects and invitations', () => {
  let harness: Harness;

  beforeEach(async () => {
    harness = await createHarness();
  });

  afterEach(async () => {
    await harness.close();
  });

  describe('projects', () => {
    it('creates a project with a derived key and lists it', async () => {
      const account = await registerAccount(harness);
      const created = await harness.api.json('POST', '/api/v1/projects', {
        token: account.accessToken,
        body: { name: 'Kampala Branch 2026' },
      });
      expect(created.statusCode).toBe(201);
      expect(created.json<{ key: string }>().key).toBe('KAMPALA-BRANCH-2026');

      const list = await harness.api.json('GET', '/api/v1/projects', {
        token: account.accessToken,
      });
      const listed = list.json<{ items: Array<{ id: string }> }>().items;
      expect(listed.map((item) => item.id)).toContain(created.json<{ id: string }>().id);
    });

    it('refuses a duplicate key', async () => {
      const account = await registerAccount(harness);
      await harness.api.json('POST', '/api/v1/projects', {
        token: account.accessToken,
        body: { name: 'Records', key: 'REC' },
      });
      const duplicate = await harness.api.json('POST', '/api/v1/projects', {
        token: account.accessToken,
        body: { name: 'Other records', key: 'REC' },
      });
      expect(duplicate.statusCode).toBe(409);
    });

    it('archives rather than deletes, and hides the project from the default list', async () => {
      const account = await registerAccount(harness);
      const created = await harness.api.json('POST', '/api/v1/projects', {
        token: account.accessToken,
        body: { name: 'Temporary' },
      });
      const id = created.json<{ id: string }>().id;

      const archived = await harness.api.json('DELETE', `/api/v1/projects/${id}`, {
        token: account.accessToken,
      });
      expect(archived.statusCode).toBe(204);

      const active = await harness.api.json('GET', '/api/v1/projects', {
        token: account.accessToken,
      });
      expect(active.json<{ items: unknown[] }>().items).toHaveLength(0);

      const withArchived = await harness.api.json('GET', '/api/v1/projects?includeArchived=true', {
        token: account.accessToken,
      });
      expect(
        withArchived.json<{ items: Array<{ archivedAt: string | null }> }>().items[0]?.archivedAt,
      ).toBeTruthy();
    });

    it('keeps projects invisible to another organisation', async () => {
      const account = await registerAccount(harness);
      const created = await harness.api.json('POST', '/api/v1/projects', {
        token: account.accessToken,
        body: { name: 'Private' },
      });

      const other = await registerAccount(harness);
      const projectId = created.json<{ id: string }>().id;
      const patch = await harness.api.json('PATCH', `/api/v1/projects/${projectId}`, {
        token: other.accessToken,
        body: { name: 'Stolen' },
      });
      expect(patch.statusCode).toBe(404);
    });
  });

  describe('invitations', () => {
    async function invitationOf(
      pending: ReturnType<typeof invite>,
    ): Promise<{ token: string; acceptUrl: string; expiresAt: string; id: string }> {
      const response = await pending;
      if (response.statusCode !== 202) throw new Error(`invite failed: ${response.body}`);
      return response.json<{
        invitation: { token: string; acceptUrl: string; expiresAt: string; id: string };
      }>().invitation;
    }

    async function invite(account: { accessToken: string }, email = 'new-person@example.com') {
      const response = await harness.api.json('POST', '/api/v1/users/invite', {
        token: account.accessToken,
        body: { email, role: 'reviewer' },
      });
      return response;
    }

    async function enrolMfa(account: { accessToken: string }) {
      const start = await harness.api.json('POST', '/api/v1/auth/mfa/enrol', {
        token: account.accessToken,
        body: { password: 'correct horse battery staple' },
      });
      expect(start.statusCode).toBe(200);
      const secret = start.json<{ secret: string }>().secret;
      const confirm = await harness.api.json('POST', '/api/v1/auth/mfa/enrol/confirm', {
        token: account.accessToken,
        body: { code: totp(secret) },
      });
      expect(confirm.statusCode).toBe(200);
      return { secret, recoveryCodes: confirm.json<{ recoveryCodes: string[] }>().recoveryCodes };
    }

    it('returns a one-time link and stores only its hash', async () => {
      const owner = await registerAccount(harness);
      const response = await invite(owner);
      expect(response.statusCode).toBe(202);

      const invitation = response.json<{
        invitation: { token: string; acceptUrl: string };
      }>().invitation;
      expect(invitation.token.length).toBeGreaterThan(20);
      expect(invitation.acceptUrl).toContain(invitation.token);

      const stored = await harness.db.query<{ token_hash: string }>(
        'SELECT token_hash FROM invitations',
      );
      expect(stored).toHaveLength(1);
      expect(stored[0]?.token_hash).not.toBe(invitation.token);
    });

    it('accepts the invitation once and signs the person in', async () => {
      const owner = await registerAccount(harness);
      const invitation = await invitationOf(invite(owner));

      const accepted = await harness.api.json(
        'POST',
        `/api/v1/invitations/${invitation.token}/accept`,
        { body: { password: 'a much better password' } },
      );
      expect(accepted.statusCode).toBe(200);
      expect(accepted.json<{ user: { role: string } }>().user.role).toBe('reviewer');
      expect(accepted.json<{ accessToken: string }>().accessToken).toBeTruthy();

      // The membership is now active, so the same token cannot be replayed.
      const replay = await harness.api.json(
        'POST',
        `/api/v1/invitations/${invitation.token}/accept`,
        {
          body: { password: 'a much better password' },
        },
      );
      expect(replay.statusCode).toBe(401);
    });

    it('rejects an expired invitation', async () => {
      const owner = await registerAccount(harness);
      const invitation = await invitationOf(invite(owner));
      await harness.db.execute('UPDATE invitations SET expires_at = ?', [
        new Date(Date.now() - 1000).toISOString(),
      ]);

      const expired = await harness.api.json(
        'POST',
        `/api/v1/invitations/${invitation.token}/accept`,
        {
          body: { password: 'a much better password' },
        },
      );
      expect(expired.statusCode).toBe(401);
      expect(expired.body).toMatch(/expired/i);
    });

    it('rejects a weak password and an invented token', async () => {
      const owner = await registerAccount(harness);
      const invitation = await invitationOf(invite(owner));

      const weak = await harness.api.json(
        'POST',
        `/api/v1/invitations/${invitation.token}/accept`,
        {
          body: { password: 'short' },
        },
      );
      expect(weak.statusCode).toBe(400);

      const invented = await harness.api.json(
        'POST',
        `/api/v1/invitations/${'x'.repeat(40)}/accept`,
        { body: { password: 'a much better password' } },
      );
      expect(invented.statusCode).toBe(401);
    });

    it('lists and revokes pending invitations, admins only', async () => {
      const owner = await registerAccount(harness);
      const invitation = await invitationOf(invite(owner));

      const listed = await harness.api.json('GET', '/api/v1/invitations', {
        token: owner.accessToken,
      });
      expect(listed.json<{ items: unknown[] }>().items).toHaveLength(1);

      const revoked = await harness.api.json('DELETE', `/api/v1/invitations/${invitation.id}`, {
        token: owner.accessToken,
      });
      expect(revoked.statusCode).toBe(204);

      const after = await harness.api.json(
        'POST',
        `/api/v1/invitations/${invitation.token}/accept`,
        {
          body: { password: 'a much better password' },
        },
      );
      expect(after.statusCode).toBe(401);
    });

    it('does not allow another organisation to revoke an invitation', async () => {
      const owner = await registerAccount(harness);
      const other = await registerAccount(harness);
      const invitation = await invitationOf(invite(owner));
      const denied = await harness.api.json('DELETE', `/api/v1/invitations/${invitation.id}`, {
        token: other.accessToken,
      });
      expect(denied.statusCode).toBe(404);
      const accepted = await harness.api.json(
        'POST',
        `/api/v1/invitations/${invitation.token}/accept`,
        {
          body: { password: 'a much better password' },
        },
      );
      expect(accepted.statusCode).toBe(200);
    });

    it('reuses a pending membership for a renewed invitation', async () => {
      const owner = await registerAccount(harness);
      await invitationOf(invite(owner));
      const renewed = await invitationOf(invite(owner));
      const memberships = await harness.db.query<{ id: string }>(
        'SELECT id FROM memberships WHERE organisation_id = ? AND user_id = (SELECT id FROM users WHERE email = ?)',
        [owner.organisationId, 'new-person@example.com'],
      );
      expect(memberships).toHaveLength(1);
      const accepted = await harness.api.json(
        'POST',
        `/api/v1/invitations/${renewed.token}/accept`,
        {
          body: { password: 'a much better password' },
        },
      );
      expect(accepted.statusCode).toBe(200);
      expect(accepted.json<{ user: { role: string } }>().user.role).toBe('reviewer');
    });

    it('requires an existing account password without replacing it or consuming a failed invitation', async () => {
      const person = await registerAccount(harness);
      const owner = await registerAccount(harness);
      const invitation = await invitationOf(invite(owner, person.email));
      const hashBefore = await harness.db.one<{ password_hash: string }>(
        'SELECT password_hash FROM users WHERE id = ?',
        [person.userId],
      );
      const wrong = await harness.api.json(
        'POST',
        `/api/v1/invitations/${invitation.token}/accept`,
        {
          body: { password: 'not the existing password' },
        },
      );
      expect(wrong.statusCode).toBe(401);
      const accepted = await harness.api.json(
        'POST',
        `/api/v1/invitations/${invitation.token}/accept`,
        {
          body: { password: 'correct horse battery staple' },
        },
      );
      expect(accepted.statusCode).toBe(200);
      const hashAfter = await harness.db.one<{ password_hash: string }>(
        'SELECT password_hash FROM users WHERE id = ?',
        [person.userId],
      );
      expect(hashAfter?.password_hash).toBe(hashBefore?.password_hash);
    });

    it('requires both password and a valid MFA code before accepting', async () => {
      const person = await registerAccount(harness);
      const owner = await registerAccount(harness);
      const { secret } = await enrolMfa(person);
      const invitation = await invitationOf(invite(owner, person.email));
      const accept = (password: string, code?: string) =>
        harness.api.json('POST', `/api/v1/invitations/${invitation.token}/accept`, {
          body: { password, ...(code ? { code } : {}) },
        });
      expect((await accept('correct horse battery staple')).statusCode).toBe(401);
      expect((await accept('correct horse battery staple', 'BADCODE0')).statusCode).toBe(401);
      expect((await accept('not the existing password', totp(secret))).statusCode).toBe(401);
      const row = await harness.db.one<{ used_at: string | null }>(
        'SELECT used_at FROM invitations WHERE id = ?',
        [invitation.id],
      );
      expect(row?.used_at).toBeNull();
      const membership = await harness.db.one<{ accepted_at: string | null }>(
        'SELECT accepted_at FROM memberships WHERE user_id = ? AND organisation_id = ?',
        [person.userId, owner.organisationId],
      );
      expect(membership?.accepted_at).toBeNull();
      const accepted = await accept('correct horse battery staple', totp(secret));
      expect(accepted.statusCode).toBe(200);
      expect(accepted.json()).toMatchObject({
        user: { organisationId: owner.organisationId, role: 'reviewer' },
      });
      expect((await accept('correct horse battery staple', totp(secret))).statusCode).toBe(401);
    });

    it('accepts a recovery code once and rolls it back if acceptance fails', async () => {
      const person = await registerAccount(harness);
      const owner = await registerAccount(harness);
      const { recoveryCodes } = await enrolMfa(person);
      const code = recoveryCodes[0]!;
      const invitation = await invitationOf(invite(owner, person.email));
      const accept = () =>
        harness.api.json('POST', `/api/v1/invitations/${invitation.token}/accept`, {
          body: { password: 'correct horse battery staple', code },
        });
      const original = AuditRepository.prototype.record;
      const spy = jest.spyOn(AuditRepository.prototype, 'record').mockImplementation(function (
        this: AuditRepository,
        input,
      ) {
        if (input.action === 'user.invitation_accepted') throw new Error('audit unavailable');
        return original.call(this, input);
      });
      try {
        expect((await accept()).statusCode).toBe(500);
      } finally {
        spy.mockRestore();
      }
      const before = await harness.db.one<{ used_at: string | null }>(
        'SELECT used_at FROM invitations WHERE id = ?',
        [invitation.id],
      );
      expect(before?.used_at).toBeNull();
      expect((await accept()).statusCode).toBe(200);
      const status = await harness.api.get('/api/v1/auth/mfa', person.accessToken);
      expect(status.json<{ recoveryCodesRemaining: number }>().recoveryCodesRemaining).toBe(9);
      const secondOwner = await registerAccount(harness);
      const secondInvitation = await invitationOf(invite(secondOwner, person.email));
      const retry = await harness.api.json(
        'POST',
        `/api/v1/invitations/${secondInvitation.token}/accept`,
        {
          body: { password: 'correct horse battery staple', code },
        },
      );
      expect(retry.statusCode).toBe(401);
    });

    it('fails closed on an unreadable MFA secret and still allows a recovery code', async () => {
      const person = await registerAccount(harness);
      const owner = await registerAccount(harness);
      const { secret, recoveryCodes } = await enrolMfa(person);
      const invitation = await invitationOf(invite(owner, person.email));
      await harness.db.execute('UPDATE users SET mfa_secret_enc = ? WHERE id = ?', [
        'corrupt',
        person.userId,
      ]);
      const attempt = (code: string) =>
        harness.api.json('POST', `/api/v1/invitations/${invitation.token}/accept`, {
          body: { password: 'correct horse battery staple', code },
        });
      expect((await attempt(totp(secret))).statusCode).toBe(401);
      expect((await attempt(recoveryCodes[0]!)).statusCode).toBe(200);
    });

    it('does not reuse the same recovery code across concurrent invitations', async () => {
      const person = await registerAccount(harness);
      const firstOwner = await registerAccount(harness);
      const secondOwner = await registerAccount(harness);
      const { recoveryCodes } = await enrolMfa(person);
      const first = await invitationOf(invite(firstOwner, person.email));
      const second = await invitationOf(invite(secondOwner, person.email));
      const accept = (token: string) =>
        harness.api.json('POST', `/api/v1/invitations/${token}/accept`, {
          body: { password: 'correct horse battery staple', code: recoveryCodes[0] },
        });
      const results = await Promise.all([accept(first.token), accept(second.token)]);
      expect(results.map((result) => result.statusCode).sort()).toEqual([200, 401]);
      const rows = await harness.db.query<{ used_at: string | null }>(
        'SELECT used_at FROM invitations WHERE id IN (?, ?)',
        [first.id, second.id],
      );
      expect(rows.filter((row) => row.used_at !== null)).toHaveLength(1);
    });

    it('consumes only one concurrent acceptance', async () => {
      const owner = await registerAccount(harness);
      const invitation = await invitationOf(invite(owner));
      const accept = () =>
        harness.api.json('POST', `/api/v1/invitations/${invitation.token}/accept`, {
          body: { password: 'a much better password' },
        });
      const results = await Promise.all([accept(), accept()]);
      expect(results.map((response) => response.statusCode).sort()).toEqual([200, 401]);
    });

    it('rolls back invitation consumption and membership when acceptance audit fails', async () => {
      const owner = await registerAccount(harness);
      const invitation = await invitationOf(invite(owner));
      const original = AuditRepository.prototype.record;
      const spy = jest.spyOn(AuditRepository.prototype, 'record').mockImplementation(function (
        this: AuditRepository,
        input,
      ) {
        if (input.action === 'user.invitation_accepted') throw new Error('audit unavailable');
        return original.call(this, input);
      });
      try {
        const response = await harness.api.json(
          'POST',
          `/api/v1/invitations/${invitation.token}/accept`,
          { body: { password: 'a much better password' } },
        );
        expect(response.statusCode).toBe(500);
      } finally {
        spy.mockRestore();
      }
      const row = await harness.db.one<{ used_at: string | null }>(
        'SELECT used_at FROM invitations WHERE id = ?',
        [invitation.id],
      );
      expect(row?.used_at).toBeNull();
      const accepted = await harness.api.json(
        'POST',
        `/api/v1/invitations/${invitation.token}/accept`,
        { body: { password: 'a much better password' } },
      );
      expect(accepted.statusCode).toBe(200);
    });

    it('refuses to invite somebody who is already a member', async () => {
      const owner = await registerAccount(harness);
      const invitation = await invitationOf(invite(owner));
      await harness.api.json('POST', `/api/v1/invitations/${invitation.token}/accept`, {
        body: { password: 'a much better password' },
      });

      const again = await invite(owner);
      expect(again.statusCode).toBe(409);
    });
  });
});
