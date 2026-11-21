import { ConnectorRegistry, type Connector } from '@idcp/connectors';
import {
  approveDocument,
  createHarness,
  drainWorker,
  fakePng,
  registerAccount,
  SAMPLE_INVOICE_TEXT,
  uploadDocument,
} from './helpers';

it('does not silently create when the configured duplicate check cannot run', async () => {
  const create = jest
    .fn()
    .mockResolvedValue({ created: 1, updated: 0, skipped: 0, summary: 'created' });
  const lookup = jest.fn().mockResolvedValue([]);
  const connector: Connector = {
    type: 'csv',
    label: 'Duplicate safety fixture',
    capabilities: ['create'],
    validateConfig: () => undefined,
    healthCheck: async () => ({ ok: true }),
    describeSchema: async () => ({ container: 'fixture', fields: [] }),
    create,
  };
  const harness = await createHarness({}, { registry: new ConnectorRegistry([connector]) });
  try {
    const account = await registerAccount(harness);
    const response = await harness.api.json('POST', '/api/v1/connectors', {
      token: account.accessToken,
      body: { type: 'csv', name: 'test', config: {} },
    });
    const connectorId = response.json<{ id: string }>().id;
    const mapping = async (
      policy: 'append' | 'skip' | 'update' | 'merge',
      keys: string[],
      udmPath = 'invoice.number',
    ) => {
      const result = await harness.api.json('POST', '/api/v1/mapping-profiles', {
        token: account.accessToken,
        body: {
          connectorId,
          documentType: 'invoice',
          name: 'test',
          fieldMap: [{ udmPath, destinationField: 'InvoiceNumber' }],
          duplicatePolicy: policy,
          duplicateKeys: keys,
        },
      });
      expect(result.statusCode).toBe(201);
      return result.json<{ id: string }>().id;
    };
    harness.ocr.setText(SAMPLE_INVOICE_TEXT);
    const upload = await uploadDocument(harness, account, {
      content: fakePng('duplicate-policy-safety'),
    });
    const documentId = upload.json<{ id: string }>().id;
    await drainWorker(harness);
    await approveDocument(harness, account, documentId);
    const send = (mappingProfileId: string) =>
      harness.api.json('POST', `/api/v1/documents/${documentId}/send`, {
        token: account.accessToken,
        body: { connectorId, mappingProfileId },
      });
    const preview = (mappingProfileId: string) =>
      harness.api.get(
        `/api/v1/documents/${documentId}/duplicates?connectorId=${connectorId}&mappingProfileId=${mappingProfileId}`,
        account.accessToken,
      );
    const noKeys = await mapping('skip', []);
    expect((await send(noKeys)).statusCode).toBe(409);
    expect((await preview(noKeys)).statusCode).toBe(409);
    const noLookup = await mapping('update', ['InvoiceNumber']);
    expect((await send(noLookup)).statusCode).toBe(409);
    expect((await preview(noLookup)).statusCode).toBe(409);
    connector.read = lookup;
    for (const policy of ['skip', 'update', 'merge'] as const) {
      const missing = await mapping(policy, ['InvoiceNumber'], 'not.present');
      expect((await send(missing)).statusCode).toBe(409);
      expect((await preview(missing)).statusCode).toBe(409);
    }
    const duplicateKey = await mapping('skip', ['InvoiceNumber', 'InvoiceNumber']);
    expect((await send(duplicateKey)).statusCode).toBe(409);
    const unmappedKey = await mapping('skip', ['MissingKey']);
    expect((await send(unmappedKey)).statusCode).toBe(409);
    expect(create).not.toHaveBeenCalled();
    expect(lookup).not.toHaveBeenCalled();
    const append = await mapping('append', []);
    expect((await send(append)).statusCode).toBe(202);
    expect(create).toHaveBeenCalledTimes(1);
    expect(lookup).not.toHaveBeenCalled();
    const normal = await mapping('skip', ['InvoiceNumber']);
    expect((await send(normal)).statusCode).toBe(202);
    expect(lookup).toHaveBeenCalledTimes(1);
    expect(create).toHaveBeenCalledTimes(2);

    const update = jest
      .fn()
      .mockResolvedValue({ created: 0, updated: 1, skipped: 0, summary: 'updated' });
    connector.update = update;
    const updateMapping = await mapping('update', ['InvoiceNumber']);
    lookup.mockResolvedValueOnce([
      { values: { InvoiceNumber: 'INV-1042' } },
      { values: { InvoiceNumber: 'INV-1042' } },
    ]);
    expect((await send(updateMapping)).statusCode).toBe(409);
    lookup.mockResolvedValueOnce([{ values: { InvoiceNumber: 'inv 1042' } }]);
    expect((await send(updateMapping)).statusCode).toBe(409);
    expect(update).not.toHaveBeenCalled();
    expect(create).toHaveBeenCalledTimes(2);
    lookup.mockResolvedValueOnce([{ values: { InvoiceNumber: 'INV-1042' } }]);
    expect((await send(updateMapping)).statusCode).toBe(202);
    expect(update).toHaveBeenCalledTimes(1);
    const failures = await harness.db.query<{ status: string }>(
      'SELECT status FROM connector_runs WHERE connector_id = ? AND status = ?',
      [connectorId, 'failed'],
    );
    expect(failures).toHaveLength(9);
  } finally {
    await harness.close();
  }
}, 30_000);

it.each(['hubspot', 'odoo', 'quickbooks'])(
  'refuses %s updates addressed by a business key rather than the vendor ID',
  async (type) => {
    const update = jest
      .fn()
      .mockResolvedValue({ created: 0, updated: 1, skipped: 0, summary: 'updated' });
    const connector: Connector = {
      type,
      label: 'Synthetic CRM',
      capabilities: ['create', 'read', 'update'],
      validateConfig: () => undefined,
      healthCheck: async () => ({ ok: true }),
      describeSchema: async () => ({ container: 'fixture', fields: [] }),
      create: jest.fn(),
      update,
      read: async () => [{ values: { InvoiceNumber: 'INV-1042', id: '123', Id: '123' } }],
    };
    const harness = await createHarness({}, { registry: new ConnectorRegistry([connector]) });
    try {
      const account = await registerAccount(harness);
      const created = await harness.api.json('POST', '/api/v1/connectors', {
        token: account.accessToken,
        body: { type, name: 'CRM', config: {} },
      });
      expect(created.statusCode).toBe(201);
      const connectorId = created.json<{ id: string }>().id;
      const mapping = await harness.api.json('POST', '/api/v1/mapping-profiles', {
        token: account.accessToken,
        body: {
          connectorId,
          documentType: 'invoice',
          name: 'test',
          fieldMap: [{ udmPath: 'invoice.number', destinationField: 'InvoiceNumber' }],
          duplicatePolicy: 'update',
          duplicateKeys: ['InvoiceNumber'],
        },
      });
      expect(mapping.statusCode).toBe(201);
      harness.ocr.setText(SAMPLE_INVOICE_TEXT);
      const upload = await uploadDocument(harness, account, { content: fakePng('crm-id-safety') });
      const documentId = upload.json<{ id: string }>().id;
      await drainWorker(harness);
      await approveDocument(harness, account, documentId);
      const send = await harness.api.json('POST', `/api/v1/documents/${documentId}/send`, {
        token: account.accessToken,
        body: { connectorId, mappingProfileId: mapping.json<{ id: string }>().id },
      });
      expect(send.statusCode).toBe(409);
      expect(send.json()).toMatchObject({
        error: { message: expect.stringContaining('record ID') },
      });
      expect(update).not.toHaveBeenCalled();
      expect(connector.create).not.toHaveBeenCalled();
      if (type === 'odoo') {
        connector.read = async () => [{ values: { id: 'INV-1042' } }];
        const invalidIdMapping = await harness.api.json('POST', '/api/v1/mapping-profiles', {
          token: account.accessToken,
          body: {
            connectorId,
            documentType: 'invoice',
            name: 'invalid ID',
            fieldMap: [{ udmPath: 'invoice.number', destinationField: 'id' }],
            duplicatePolicy: 'update',
            duplicateKeys: ['id'],
          },
        });
        const invalidIdSend = await harness.api.json(
          'POST',
          `/api/v1/documents/${documentId}/send`,
          {
            token: account.accessToken,
            body: { connectorId, mappingProfileId: invalidIdMapping.json<{ id: string }>().id },
          },
        );
        expect(invalidIdSend.statusCode).toBe(409);
        expect(invalidIdSend.json()).toMatchObject({
          error: { message: expect.stringContaining('positive integer') },
        });
        expect(update).not.toHaveBeenCalled();
      }
    } finally {
      await harness.close();
    }
  },
  30_000,
);
