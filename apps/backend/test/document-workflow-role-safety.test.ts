import {
  acceptInvite,
  createHarness,
  fakePng,
  registerAccount,
  type Harness,
  type TestAccount,
} from './helpers';

describe('document and workflow write roles', () => {
  let harness: Harness;
  let owner: TestAccount;
  let viewer: TestAccount;
  let operator: TestAccount;
  let readOnlyKey: string;
  let writerKey: string;

  beforeAll(async () => {
    harness = await createHarness();
    owner = await registerAccount(harness);
    for (const [email, role] of [
      ['role-viewer@example.com', 'viewer'],
      ['role-operator@example.com', 'operator'],
    ] as const) {
      const invitation = await harness.api.json('POST', '/api/v1/users/invite', {
        token: owner.accessToken,
        body: { email, role },
      });
      expect(invitation.statusCode).toBe(202);
    }
    viewer = await acceptInvite(harness, 'role-viewer@example.com');
    operator = await acceptInvite(harness, 'role-operator@example.com');
    const createKey = async (scope: string) => {
      const response = await harness.api.json('POST', '/api/v1/api-keys', {
        token: owner.accessToken,
        body: { name: scope, scopes: [scope] },
      });
      expect(response.statusCode).toBe(201);
      return response.json<{ key: string }>().key;
    };
    readOnlyKey = await createKey('documents:read');
    writerKey = await createKey('documents:write');
  });
  afterAll(async () => {
    await harness.close();
  });

  const headers = (): Array<Record<string, string>> => [
    { 'x-api-key': readOnlyKey },
    { authorization: `Bearer ${viewer.accessToken}` },
  ];

  const belowReviewer = () => [...headers(), { authorization: `Bearer ${operator.accessToken}` }];

  it('prevents roles below reviewer from soft-deleting a document', async () => {
    const upload = await harness.api.upload(owner.accessToken);
    const id = upload.json<{ id: string }>().id;
    for (const auth of belowReviewer()) {
      const result = await harness.api.json('DELETE', `/api/v1/documents/${id}`, { headers: auth });
      expect(result.statusCode).toBe(403);
      expect(await harness.db.one('SELECT deleted_at FROM documents WHERE id = ?', [id])).toEqual({
        deleted_at: null,
      });
    }
    const allowed = await harness.api.json('DELETE', `/api/v1/documents/${id}`, {
      headers: { 'x-api-key': writerKey },
    });
    expect(allowed.statusCode).toBe(204);
  });

  it('prevents roles below reviewer from queuing reprocessing', async () => {
    const upload = await harness.api.upload(owner.accessToken, {
      content: fakePng('role-reprocess'),
    });
    const id = upload.json<{ id: string }>().id;
    await harness.services.worker.drain();
    for (const auth of belowReviewer()) {
      const result = await harness.api.json('POST', `/api/v1/documents/${id}/reprocess`, {
        headers: auth,
      });
      expect(result.statusCode).toBe(403);
    }
    const allowed = await harness.api.json('POST', `/api/v1/documents/${id}/reprocess`, {
      headers: { 'x-api-key': writerKey },
    });
    expect(allowed.statusCode).toBe(202);
  });

  it('prevents roles below reviewer from executing a workflow evaluation', async () => {
    const upload = await harness.api.upload(owner.accessToken, {
      content: fakePng('role-workflow'),
    });
    const id = upload.json<{ id: string }>().id;
    const workflow = await harness.api.json('POST', '/api/v1/workflows', {
      token: owner.accessToken,
      body: {
        name: 'Automatic delete',
        trigger: 'document.extracted',
        conditions: [],
        approvalPolicy: 'auto_approve',
        actions: [{ type: 'delete_document' }],
      },
    });
    expect(workflow.statusCode).toBe(201);
    for (const auth of belowReviewer()) {
      const result = await harness.api.json('POST', '/api/v1/workflows/evaluate', {
        headers: auth,
        body: { trigger: 'document.extracted', documentId: id },
      });
      expect(result.statusCode).toBe(403);
      expect(await harness.db.one('SELECT deleted_at FROM documents WHERE id = ?', [id])).toEqual({
        deleted_at: null,
      });
    }
    expect(
      await harness.db.query('SELECT id FROM workflow_runs WHERE workflow_id = ?', [
        workflow.json<{ id: string }>().id,
      ]),
    ).toHaveLength(0);
    const allowed = await harness.api.json('POST', '/api/v1/workflows/evaluate', {
      headers: { 'x-api-key': writerKey },
      body: { trigger: 'document.extracted', documentId: id },
    });
    expect(allowed.statusCode).toBe(200);
    expect(
      await harness.db.one<{ deleted_at: string | null }>(
        'SELECT deleted_at FROM documents WHERE id = ?',
        [id],
      ),
    ).toMatchObject({ deleted_at: expect.any(String) });
  });

  it('enforces the same restrictions for direct service calls', async () => {
    const actor = {
      userId: viewer.userId,
      organisationId: viewer.organisationId,
      role: 'viewer' as const,
      actorType: 'user' as const,
    };
    await expect(
      harness.services.documents.upload(actor, { buffer: fakePng() }),
    ).rejects.toMatchObject({ code: 'ROLE_REQUIRED' });
    await expect(
      harness.services.documents.reprocess(actor, 'not-a-document'),
    ).rejects.toMatchObject({ code: 'ROLE_REQUIRED' });
    await expect(harness.services.documents.delete(actor, 'not-a-document')).rejects.toMatchObject({
      code: 'ROLE_REQUIRED',
    });
    await expect(
      harness.services.workflows.evaluate(actor, { trigger: 'document.extracted' }),
    ).rejects.toMatchObject({ code: 'ROLE_REQUIRED' });
  });

  it('requires at least operator for upload and preserves operator uploads', async () => {
    const uploadWith = async (auth: Record<string, string>) => {
      const form = new FormData();
      form.append(
        'file',
        new Blob([new Uint8Array(fakePng('role-upload'))], { type: 'image/png' }),
        'scan.png',
      );
      return fetch(`${harness.baseUrl}/api/v1/documents`, {
        method: 'POST',
        headers: auth,
        body: form,
      });
    };
    for (const auth of headers()) expect((await uploadWith(auth)).status).toBe(403);
    expect((await uploadWith({ authorization: `Bearer ${operator.accessToken}` })).status).toBe(
      201,
    );
  });
});
