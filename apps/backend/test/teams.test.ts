import { createHarness, registerAccount, type Harness } from './helpers';

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
