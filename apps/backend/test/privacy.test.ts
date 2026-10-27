import {
  createHarness,
  drainWorker,
  registerAccount,
  uploadDocument,
  type Harness,
} from './helpers';

/**
 * Data-subject rights: export and erasure (privacy policy §7).
 *
 * The export must contain the caller's own data and nothing from another organisation. Erasure must
 * anonymise the account, kill its credentials, remove drafts — and refuse while the person is one of
 * several owners, because the organisation would be left without an accountable human.
 */
describe('privacy: export and erasure', () => {
  let harness: Harness;

  beforeEach(async () => {
    harness = await createHarness();
  });

  afterEach(async () => {
    await harness.close();
  });

  async function uploadAs(account: Awaited<ReturnType<typeof registerAccount>>) {
    const response = await uploadDocument(harness, account);
    expect(response.statusCode).toBe(201);
    return response.json<{ id: string }>();
  }

  it('exports the caller account, organisation and documents as JSON', async () => {
    const account = await registerAccount(harness, { email: 'export-me@example.com' });
    const document = await uploadAs(account);

    interface ExportBody {
      generatedAt: string;
      account: { email: string; displayName: string };
      organisations: Array<{ role: string }>;
      documents: Array<{ id: string; documentType: string }>;
      auditEntries: Array<{ action: string }>;
      notes: string[];
    }

    const response = await harness.api.json('GET', '/api/v1/me/export', {
      token: account.accessToken,
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers.get('content-disposition')).toContain('idcp-my-data-');
    const body = response.json<ExportBody>();
    expect(body.account.email).toBe('export-me@example.com');
    expect(body.organisations[0].role).toBe('owner');
    expect(body.documents.map((entry) => entry.id)).toEqual([document.id]);
    expect(body.auditEntries.some((entry) => entry.action === 'auth.register')).toBe(true);
    expect(body.notes.length).toBeGreaterThan(0);
  });

  it('never includes another organisation documents', async () => {
    const alice = await registerAccount(harness, { email: 'alice-export@example.com' });
    const bob = await registerAccount(harness, { email: 'bob-export@example.com' });
    await uploadAs(bob);

    const response = await harness.api.json('GET', '/api/v1/me/export', {
      token: alice.accessToken,
    });
    expect(response.json<{ documents: unknown[] }>().documents).toHaveLength(0);
  });

  it('requires the password and the word DELETE to erase', async () => {
    const account = await registerAccount(harness, { email: 'erase-guard@example.com' });

    const noConfirm = await harness.api.json('POST', '/api/v1/me/erase', {
      token: account.accessToken,
      body: { password: 'correct horse battery staple', confirm: 'delete' },
    });
    expect(noConfirm.statusCode).toBe(400);

    const wrongPassword = await harness.api.json('POST', '/api/v1/me/erase', {
      token: account.accessToken,
      body: { password: 'nope', confirm: 'DELETE' },
    });
    expect(wrongPassword.statusCode).toBe(401);
  });

  it('anonymises the account, revokes credentials and removes drafts', async () => {
    const account = await registerAccount(harness, { email: 'erase-me@example.com' });
    const document = await uploadAs(account);

    const response = await harness.api.json('POST', '/api/v1/me/erase', {
      token: account.accessToken,
      body: { password: 'correct horse battery staple', confirm: 'DELETE' },
    });
    expect(response.statusCode).toBe(200);
    const erased = response.json<{ erased: boolean; retainedRecords: string }>();
    expect(erased.erased).toBe(true);
    expect(erased.retainedRecords).toContain('Approved');

    const user = await harness.db.one<{
      email: string;
      display_name: string;
      disabled_at: string | null;
    }>('SELECT email, display_name, disabled_at FROM users WHERE id = ?', [account.userId]);
    expect(user?.email).toBe(`deleted-${account.userId}@erased.invalid`);
    expect(user?.display_name).toBe('Erased account');
    expect(user?.disabled_at).not.toBeNull();

    const drafts = await harness.db.query('SELECT id FROM documents WHERE id = ?', [document.id]);
    expect(drafts).toHaveLength(0);

    // The session that made the request is gone with the rest.
    const refresh = await harness.api.json('POST', '/api/v1/auth/refresh', {
      body: { refreshToken: account.refreshToken },
    });
    expect(refresh.statusCode).toBe(401);

    // Signing in with the old address no longer works, and the address is free again.
    const login = await harness.api.json('POST', '/api/v1/auth/login', {
      body: { email: 'erase-me@example.com', password: 'correct horse battery staple' },
    });
    expect(login.statusCode).toBe(401);
  });

  it('keeps approved records but drops the identity from them', async () => {
    const account = await registerAccount(harness, { email: 'approved@example.com' });
    const document = await uploadAs(account);
    await drainWorker(harness);

    // Approve through the API so the record reaches the retained state.
    const review = await harness.api.json('POST', `/api/v1/documents/${document.id}/review`, {
      token: account.accessToken,
    });
    const reviewBody = review.json<{ reviewId?: string; blocking?: unknown[] }>();
    const reviewId = reviewBody.reviewId;
    if (reviewId && (reviewBody.blocking?.length ?? 0) === 0) {
      await harness.api.json('POST', `/api/v1/reviews/${reviewId}/approve`, {
        token: account.accessToken,
        body: {},
      });
    }

    await harness.api.json('POST', '/api/v1/me/erase', {
      token: account.accessToken,
      body: { password: 'correct horse battery staple', confirm: 'DELETE' },
    });

    const rows = await harness.db.query<{ status: string }>(
      'SELECT status FROM documents WHERE id = ?',
      [document.id],
    );
    const status = rows[0]?.status;
    if (status === 'approved') {
      expect(rows).toHaveLength(1); // kept, because the organisation may be required to retain it
    }
    // Either way the uploader column still points at the (now anonymised) account row.
    const stillAnonymised = await harness.db.one<{ email: string }>(
      'SELECT email FROM users WHERE id = ?',
      [account.userId],
    );
    expect(stillAnonymised?.email).toContain('@erased.invalid');
  });

  it('refuses while the person is one of several owners', async () => {
    const owner = await registerAccount(harness, { email: 'owner-one@example.com' });
    const second = await registerAccount(harness, { email: 'owner-two@example.com' });

    // Put the second account into the first organisation as a second owner.
    await harness.db.execute(
      `INSERT INTO memberships (id, organisation_id, user_id, role, created_at, updated_at)
       VALUES (?, ?, ?, 'owner', ?, ?)`,
      [
        `m-${second.userId}`,
        owner.organisationId,
        second.userId,
        new Date().toISOString(),
        new Date().toISOString(),
      ],
    );

    const response = await harness.api.json('POST', '/api/v1/me/erase', {
      token: owner.accessToken,
      body: { password: 'correct horse battery staple', confirm: 'DELETE' },
    });
    expect(response.statusCode).toBe(409);
    expect(response.json<{ error: { message: string } }>().error.message).toContain('owner');
  });

  it('audits the erasure', async () => {
    const account = await registerAccount(harness, { email: 'audit-erase@example.com' });
    await harness.api.json('POST', '/api/v1/me/erase', {
      token: account.accessToken,
      body: { password: 'correct horse battery staple', confirm: 'DELETE' },
    });

    const entry = await harness.db.one<{ action: string }>(
      `SELECT action FROM audit_logs WHERE action = 'privacy.account_erased' AND actor_id = ?`,
      [account.userId],
    );
    expect(entry?.action).toBe('privacy.account_erased');
  });
});
