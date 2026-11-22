import { ConnectorRegistry, type Connector } from '@idcp/connectors';
import {
  acceptInvite,
  approveDocument,
  createHarness,
  fakePng,
  openReview,
  registerAccount,
  SAMPLE_INVOICE_TEXT,
  type Harness,
  type TestAccount,
} from './helpers';

describe('review, send, and batch role safety', () => {
  let harness: Harness;
  let owner: TestAccount;
  let readKey: string;
  let writeKey: string;
  const create = jest.fn().mockResolvedValue({ created: 1, updated: 0, skipped: 0, summary: 'ok' });

  beforeAll(async () => {
    const connector: Connector = {
      type: 'csv',
      label: 'test',
      capabilities: ['create'],
      validateConfig: () => undefined,
      healthCheck: async () => ({ ok: true }),
      describeSchema: async () => ({ container: 'test', fields: [] }),
      create,
    };
    harness = await createHarness({}, { registry: new ConnectorRegistry([connector]) });
    owner = await registerAccount(harness);
    const key = async (scope: string) => {
      const result = await harness.api.json('POST', '/api/v1/api-keys', {
        token: owner.accessToken,
        body: { name: scope, scopes: [scope] },
      });
      expect(result.statusCode).toBe(201);
      return result.json<{ key: string }>().key;
    };
    readKey = await key('documents:read');
    writeKey = await key('review:write');
  });
  afterAll(async () => {
    await harness.close();
  });

  it('prevents read-only keys from opening, altering, approving or rejecting a review', async () => {
    harness.ocr.setText(SAMPLE_INVOICE_TEXT);
    const uploaded = await harness.api.upload(owner.accessToken, {
      content: fakePng('review-role'),
    });
    const documentId = uploaded.json<{ id: string }>().id;
    await harness.services.worker.drain();
    const headers = { 'x-api-key': readKey };
    const opened = await harness.api.json('POST', `/api/v1/documents/${documentId}/review`, {
      headers,
    });
    expect(opened.statusCode).toBe(403);
    expect(
      await harness.db.query('SELECT id FROM reviews WHERE document_id = ?', [documentId]),
    ).toHaveLength(0);

    const review = await openReview(harness, owner, documentId);
    const before = await harness.db.one<{ n: number }>(
      'SELECT COUNT(*) AS n FROM extractions WHERE document_id = ?',
      [documentId],
    );
    const patch = await harness.api.json('PATCH', `/api/v1/review/${review.reviewId}/fields`, {
      headers,
      body: { changes: [{ fieldPath: 'invoice.number', value: 'unauthorised' }] },
    });
    expect(patch.statusCode).toBe(403);
    expect(
      (
        await harness.api.json('POST', `/api/v1/review/${review.reviewId}/approve`, {
          headers,
          body: {},
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await harness.api.json('POST', `/api/v1/review/${review.reviewId}/reject`, {
          headers,
          body: { reason: 'no' },
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await harness.api.json('POST', '/api/v1/review/bulk-approve', {
          headers,
          body: { documentIds: [documentId] },
        })
      ).statusCode,
    ).toBe(403);
    const after = await harness.db.one<{ n: number }>(
      'SELECT COUNT(*) AS n FROM extractions WHERE document_id = ?',
      [documentId],
    );
    expect(Number(after!.n)).toBe(Number(before!.n));
    expect(
      await harness.db.one('SELECT status FROM reviews WHERE id = ?', [review.reviewId]),
    ).toEqual({ status: 'in_progress' });
    const allowed = await harness.api.json('PATCH', `/api/v1/review/${review.reviewId}/fields`, {
      headers: { 'x-api-key': writeKey },
      body: { changes: [{ fieldPath: 'invoice.number', value: 'reviewer-value' }] },
    });
    expect(allowed.statusCode).toBe(200);
  });

  it('does not send approved records to a connector using a read-only key', async () => {
    harness.ocr.setText(SAMPLE_INVOICE_TEXT);
    const upload = await harness.api.upload(owner.accessToken, { content: fakePng('send-role') });
    const documentId = upload.json<{ id: string }>().id;
    await harness.services.worker.drain();
    await approveDocument(harness, owner, documentId);
    const conn = await harness.api.json('POST', '/api/v1/connectors', {
      token: owner.accessToken,
      body: { type: 'csv', name: 'fixture', config: {} },
    });
    expect(conn.statusCode).toBe(201);
    const connectorId = conn.json<{ id: string }>().id;
    const mapping = await harness.api.json('POST', '/api/v1/mapping-profiles', {
      token: owner.accessToken,
      body: {
        connectorId,
        name: 'fixture',
        documentType: 'invoice',
        fieldMap: [{ udmPath: 'invoice.number', destinationField: 'number' }],
        duplicatePolicy: 'append',
      },
    });
    expect(mapping.statusCode).toBe(201);
    const mappingProfileId = mapping.json<{ id: string }>().id;
    const path = `/api/v1/documents/${documentId}/send`;
    expect(
      (
        await harness.api.json('POST', path, {
          headers: { 'x-api-key': readKey },
          body: { connectorId, mappingProfileId },
        })
      ).statusCode,
    ).toBe(403);
    expect(create).not.toHaveBeenCalled();
    expect(
      (
        await harness.api.json('POST', path, {
          headers: { 'x-api-key': writeKey },
          body: { connectorId, mappingProfileId },
        })
      ).statusCode,
    ).toBe(202);
    expect(create).toHaveBeenCalledTimes(1);
  });

  it('rejects direct service mutations before accessing their inputs or repositories', async () => {
    const actor = {
      userId: owner.userId,
      organisationId: owner.organisationId,
      role: 'viewer' as const,
      actorType: 'api_key' as const,
    };
    const denied = { code: 'ROLE_REQUIRED' };
    await expect(harness.services.reviews.open(actor, 'none')).rejects.toMatchObject(denied);
    await expect(harness.services.reviews.patchFields(actor, 'none', [])).rejects.toMatchObject(
      denied,
    );
    await expect(harness.services.reviews.approve(actor, 'none')).rejects.toMatchObject(denied);
    await expect(harness.services.reviews.reject(actor, 'none', 'reason')).rejects.toMatchObject(
      denied,
    );
    await expect(harness.services.reviews.bulkApprove(actor, [])).rejects.toMatchObject(denied);
    await expect(
      harness.services.connectors.sendDocument(actor, 'none', 'none', 'none'),
    ).rejects.toMatchObject(denied);
    await expect(
      harness.services.connectors.createMapping(actor, {
        name: 'test',
        documentType: 'invoice',
        fieldMap: [
          {
            udmPath: 'invoice.number',
            destinationField: 'number',
            transform: 'none',
            required: false,
          },
        ],
        duplicatePolicy: 'append',
        duplicateKeys: [],
      }),
    ).rejects.toMatchObject(denied);
    const operator = { ...actor, role: 'operator' as const };
    await expect(harness.services.reviews.open(operator, 'none')).rejects.toMatchObject(denied);
    await expect(harness.services.reviews.bulkApprove(operator, [])).rejects.toMatchObject(denied);
    await expect(
      harness.services.connectors.sendDocument(operator, 'none', 'none', 'none'),
    ).rejects.toMatchObject(denied);
    const files = {
      [Symbol.asyncIterator]: () => {
        throw new Error('must not consume');
      },
    };
    await expect(harness.services.batches.create(actor, { files })).rejects.toMatchObject(denied);
  });

  it('rejects read-only batch uploads before creating a batch', async () => {
    const post = (key: string) => {
      const form = new FormData();
      form.append(
        'files',
        new Blob([new Uint8Array(fakePng('batch-role'))], { type: 'image/png' }),
        'one.png',
      );
      return fetch(`${harness.baseUrl}/api/v1/batches`, {
        method: 'POST',
        headers: { 'x-api-key': key },
        body: form,
      });
    };
    const before = await harness.db.one<{ n: number }>(
      'SELECT COUNT(*) AS n FROM batches WHERE organisation_id = ?',
      [owner.organisationId],
    );
    expect((await post(readKey)).status).toBe(403);
    const after = await harness.db.one<{ n: number }>(
      'SELECT COUNT(*) AS n FROM batches WHERE organisation_id = ?',
      [owner.organisationId],
    );
    expect(Number(after!.n)).toBe(Number(before!.n));
    expect((await post(writeKey)).status).toBe(201);

    const invite = await harness.api.json('POST', '/api/v1/users/invite', {
      token: owner.accessToken,
      body: { email: 'batch-operator@example.com', role: 'operator' },
    });
    expect(invite.statusCode).toBe(202);
    const operator = await acceptInvite(harness, 'batch-operator@example.com');
    const form = new FormData();
    form.append(
      'files',
      new Blob([new Uint8Array(fakePng('operator-batch'))], { type: 'image/png' }),
      'one.png',
    );
    const allowed = await fetch(`${harness.baseUrl}/api/v1/batches`, {
      method: 'POST',
      headers: { authorization: `Bearer ${operator.accessToken}` },
      body: form,
    });
    expect(allowed.status).toBe(201);
    const batch = (await allowed.json()) as { total: number; items: Array<{ status: string }> };
    expect(batch.total).toBe(1);
    expect(batch.items[0]?.status).not.toBe('failed');
  });
});
