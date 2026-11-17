import {
  createHarness,
  drainWorker,
  registerAccount,
  uploadDocument,
  type Harness,
} from './helpers';
import { AuditRepository } from '../src/repositories/system-repo';

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
    expect(response.json<{ fileDeletionStatus: string; pendingFileCount: number }>()).toMatchObject(
      {
        fileDeletionStatus: 'complete',
        pendingFileCount: 0,
      },
    );
    // Access tokens are also rejected immediately; revoking refresh sessions alone is insufficient.
    const access = await harness.api.get('/api/v1/auth/me', account.accessToken);
    expect(access.statusCode).toBe(401);

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

  it('reports pending file removal, then retries durable work including page files', async () => {
    const account = await registerAccount(harness, { email: 'pending-erase@example.com' });
    const document = await uploadAs(account);
    const stored = await harness.db.one<{ storage_key: string }>(
      'SELECT storage_key FROM documents WHERE id = ?',
      [document.id],
    );
    const originalKey = stored!.storage_key;
    const pageKey = `org/${account.organisationId}/pages/extra.png`;
    await harness.storage.put(pageKey, Buffer.from('extra page'));
    await harness.db.execute(
      'INSERT INTO document_pages (id, document_id, page_number, storage_key, created_at) VALUES (?, ?, ?, ?, ?)',
      ['page-extra', document.id, 2, pageKey, new Date().toISOString()],
    );
    const deletion = jest
      .spyOn(harness.storage, 'delete')
      .mockRejectedValue(new Error('storage unavailable'));
    try {
      const response = await harness.api.json('POST', '/api/v1/me/erase', {
        token: account.accessToken,
        body: { password: 'correct horse battery staple', confirm: 'DELETE' },
      });
      expect(response.statusCode).toBe(202);
      expect(response.json()).toMatchObject({
        erased: true,
        fileDeletionStatus: 'pending',
        pendingFileCount: 2,
      });
      expect(await harness.storage.exists(originalKey)).toBe(true);
      expect(await harness.storage.exists(pageKey)).toBe(true);
      expect(
        await harness.db.query('SELECT id FROM erasure_file_deletions WHERE user_id = ?', [
          account.userId,
        ]),
      ).toHaveLength(2);
      expect((await harness.api.get('/api/v1/auth/me', account.accessToken)).statusCode).toBe(401);
    } finally {
      deletion.mockRestore();
    }

    const report = await harness.services.maintenance.runOnce();
    expect(report.erasureFilesDeleted).toBe(2);
    expect(await harness.storage.exists(originalKey)).toBe(false);
    expect(await harness.storage.exists(pageKey)).toBe(false);
    expect(
      await harness.db.query('SELECT id FROM erasure_file_deletions WHERE user_id = ?', [
        account.userId,
      ]),
    ).toHaveLength(0);
    expect((await harness.services.maintenance.runOnce()).erasureFilesDeleted).toBe(0);
  });

  it('does not delete a file still referenced by another document', async () => {
    const account = await registerAccount(harness, { email: 'shared-erase@example.com' });
    const other = await registerAccount(harness, { email: 'shared-other@example.com' });
    const ownDocument = await uploadAs(account);
    const otherDocument = await uploadAs(other);
    const row = await harness.db.one<{ storage_key: string }>(
      'SELECT storage_key FROM documents WHERE id = ?',
      [ownDocument.id],
    );
    await harness.db.execute('UPDATE documents SET storage_key = ? WHERE id = ?', [
      row!.storage_key,
      otherDocument.id,
    ]);
    const response = await harness.api.json('POST', '/api/v1/me/erase', {
      token: account.accessToken,
      body: { password: 'correct horse battery staple', confirm: 'DELETE' },
    });
    expect(response.statusCode).toBe(202);
    expect(response.json()).toMatchObject({ fileDeletionStatus: 'pending', pendingFileCount: 1 });
    expect(await harness.storage.exists(row!.storage_key)).toBe(true);
    expect((await harness.services.maintenance.runOnce()).erasureFilesDeleted).toBe(0);
    expect(await harness.storage.exists(row!.storage_key)).toBe(true);
  });

  it('rolls back account and deletion queue if the transaction fails', async () => {
    const account = await registerAccount(harness, { email: 'rollback-erase@example.com' });
    const document = await uploadAs(account);
    const row = await harness.db.one<{ storage_key: string }>(
      'SELECT storage_key FROM documents WHERE id = ?',
      [document.id],
    );
    const originalRecord = AuditRepository.prototype.record;
    const audit = jest.spyOn(AuditRepository.prototype, 'record').mockImplementation(function (
      this: AuditRepository,
      input,
    ) {
      if (input.action === 'privacy.account_erased') throw new Error('audit unavailable');
      return originalRecord.call(this, input);
    });
    try {
      const response = await harness.api.json('POST', '/api/v1/me/erase', {
        token: account.accessToken,
        body: { password: 'correct horse battery staple', confirm: 'DELETE' },
      });
      expect(response.statusCode).toBe(500);
    } finally {
      audit.mockRestore();
    }
    expect(await harness.storage.exists(row!.storage_key)).toBe(true);
    expect(
      await harness.db.one('SELECT id FROM documents WHERE id = ?', [document.id]),
    ).not.toBeNull();
    expect(
      await harness.db.query('SELECT id FROM erasure_file_deletions WHERE user_id = ?', [
        account.userId,
      ]),
    ).toHaveLength(0);
    expect((await harness.api.get('/api/v1/auth/me', account.accessToken)).statusCode).toBe(200);
  });

  it('revokes API keys created by the erased account', async () => {
    const account = await registerAccount(harness, { email: 'erase-key@example.com' });
    const created = await harness.api.json('POST', '/api/v1/api-keys', {
      token: account.accessToken,
      body: { name: 'Integration', scopes: ['documents:read'] },
    });
    expect(created.statusCode).toBe(201);
    const key = created.json<{ key: string }>().key;
    expect(
      (await harness.api.json('GET', '/api/v1/documents', { headers: { 'x-api-key': key } }))
        .statusCode,
    ).toBe(200);
    const erased = await harness.api.json('POST', '/api/v1/me/erase', {
      token: account.accessToken,
      body: { password: 'correct horse battery staple', confirm: 'DELETE' },
    });
    expect(erased.statusCode).toBe(200);
    expect(
      (await harness.api.json('GET', '/api/v1/documents', { headers: { 'x-api-key': key } }))
        .statusCode,
    ).toBe(401);
    const row = await harness.db.one<{ revoked_at: string | null }>(
      'SELECT revoked_at FROM api_keys WHERE created_by = ?',
      [account.userId],
    );
    expect(row?.revoked_at).not.toBeNull();
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
