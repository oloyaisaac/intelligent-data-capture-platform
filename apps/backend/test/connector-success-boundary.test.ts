import { ConnectorRegistry, type Connector } from '@idcp/connectors';
import { createLogger } from '../src/logger';
import {
  approveDocument,
  createHarness,
  drainWorker,
  fakePng,
  registerAccount,
  SAMPLE_INVOICE_TEXT,
  uploadDocument,
} from './helpers';

/** Success data is untrusted too; this does not isolate connector code from the host process. */
it('does not expose or persist connector-supplied summaries or extra success properties', async () => {
  const secret = 'connector-secret-on-success-6248';
  const logs: string[] = [];
  const create = jest
    .fn()
    .mockResolvedValueOnce({
      created: 1,
      updated: 0,
      skipped: 0,
      summary: `created ${secret}`,
      extra: secret,
    })
    .mockResolvedValueOnce({ created: -1, updated: 0, skipped: 0, summary: secret })
    .mockResolvedValueOnce({ created: 1.5, updated: 0, skipped: 0, summary: secret })
    .mockResolvedValueOnce({ created: Infinity, updated: 0, skipped: 0, summary: secret })
    .mockResolvedValueOnce({ created: secret, updated: 0, skipped: 0, summary: secret })
    .mockResolvedValueOnce(null);
  const update = jest.fn().mockResolvedValue({
    created: 0,
    updated: 1,
    skipped: 0,
    summary: `updated ${secret}`,
    extra: secret,
  });
  const connector: Connector = {
    type: 'csv',
    label: 'Success boundary test',
    capabilities: ['create', 'read', 'update'],
    validateConfig: () => undefined,
    healthCheck: async () => ({ ok: true }),
    describeSchema: async () => ({ container: 'test', fields: [] }),
    create,
    update,
    read: async () => [{ values: { InvoiceNumber: 'INV-1042' } }],
  };
  const logger = createLogger({ level: 'debug', sink: (line) => logs.push(line) });
  const harness = await createHarness({}, { registry: new ConnectorRegistry([connector]), logger });
  try {
    const account = await registerAccount(harness);
    const created = await harness.api.json('POST', '/api/v1/connectors', {
      token: account.accessToken,
      body: { type: 'csv', name: 'Success boundary', config: {} },
    });
    expect(created.statusCode).toBe(201);
    const connectorId = created.json<{ id: string }>().id;
    const mapping = async (policy: 'append' | 'update') => {
      const response = await harness.api.json('POST', '/api/v1/mapping-profiles', {
        token: account.accessToken,
        body: {
          connectorId,
          documentType: 'invoice',
          name: `${policy} mapping`,
          fieldMap: [{ udmPath: 'invoice.number', destinationField: 'InvoiceNumber' }],
          duplicatePolicy: policy,
          duplicateKeys: policy === 'update' ? ['InvoiceNumber'] : [],
        },
      });
      expect(response.statusCode).toBe(201);
      return response.json<{ id: string }>().id;
    };
    const append = await mapping('append');
    const updateId = await mapping('update');
    harness.ocr.setText(SAMPLE_INVOICE_TEXT);
    const upload = await uploadDocument(harness, account, {
      content: fakePng('safe connector success'),
    });
    const documentId = upload.json<{ id: string }>().id;
    await drainWorker(harness);
    await approveDocument(harness, account, documentId);
    const send = (mappingProfileId: string) =>
      harness.api.json('POST', `/api/v1/documents/${documentId}/send`, {
        token: account.accessToken,
        body: { connectorId, mappingProfileId },
      });
    const first = await send(append);
    expect(first.statusCode).toBe(202);
    expect(first.json()).toMatchObject({ status: 'succeeded', created: 1 });
    expect(first.body).not.toContain(secret);
    const second = await send(updateId);
    expect(second.statusCode).toBe(202);
    expect(second.json()).toMatchObject({ status: 'succeeded', updated: 1 });
    expect(second.body).not.toContain(secret);
    // The destination may already have changed despite malformed reporting; the caller must check it.
    for (let i = 0; i < 5; i += 1) {
      const invalid = await send(append);
      expect(invalid.statusCode).toBe(422);
      expect(invalid.body).not.toContain(secret);
      expect(invalid.json<{ error: { message: string } }>().error.message).toContain(
        'destination for changes',
      );
    }
    const rows = await harness.db.query<{
      status: string;
      response_summary: string | null;
      error: string | null;
    }>('SELECT status, response_summary, error FROM connector_runs WHERE connector_id = ?', [
      connectorId,
    ]);
    expect(rows.filter((row) => row.status === 'succeeded')).toHaveLength(2);
    expect(rows.filter((row) => row.status === 'failed')).toHaveLength(5);
    expect(JSON.stringify(rows)).not.toContain(secret);
    const listed = await harness.api.get(
      `/api/v1/connectors/${connectorId}/runs`,
      account.accessToken,
    );
    expect(listed.body).not.toContain(secret);
    expect(logs.join('\n')).not.toContain(secret);
  } finally {
    await harness.close();
  }
});
