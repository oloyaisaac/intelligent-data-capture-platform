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

it('rejects colliding or prototype-named mappings at creation and before using legacy mappings', async () => {
  const create = jest.fn().mockResolvedValue({ created: 1, updated: 0, skipped: 0, summary: 'ok' });
  const read = jest.fn().mockResolvedValue([]);
  const connector: Connector = {
    type: 'csv',
    label: 'fixture',
    capabilities: ['create', 'read'],
    validateConfig: () => undefined,
    healthCheck: async () => ({ ok: true }),
    describeSchema: async () => ({ container: 'fixture', fields: [] }),
    create,
    read,
  };
  const harness = await createHarness({}, { registry: new ConnectorRegistry([connector]) });
  try {
    const account = await registerAccount(harness);
    const created = await harness.api.json('POST', '/api/v1/connectors', {
      token: account.accessToken,
      body: { type: 'csv', name: 'fixture', config: {} },
    });
    expect(created.statusCode).toBe(201);
    const connectorId = created.json<{ id: string }>().id;
    const valid = [{ udmPath: 'invoice.number', destinationField: 'InvoiceNumber' }];
    const duplicate = [
      { udmPath: 'invoice.number', destinationField: 'InvoiceNumber' },
      { udmPath: 'supplier.name', destinationField: 'InvoiceNumber' },
    ];
    const cases = [
      duplicate,
      ...['__proto__', 'constructor', 'toString'].map((destinationField) => [
        { udmPath: 'invoice.number', destinationField },
      ]),
    ];
    const createMapping = (fieldMap: typeof duplicate) =>
      harness.api.json('POST', '/api/v1/mapping-profiles', {
        token: account.accessToken,
        body: {
          connectorId,
          documentType: 'invoice',
          name: 'fixture',
          fieldMap,
          duplicatePolicy: 'skip',
          duplicateKeys: ['InvoiceNumber'],
        },
      });
    for (const fieldMap of cases) {
      expect((await createMapping(fieldMap)).statusCode).toBe(400);
    }
    const mapping = await createMapping(valid);
    expect(mapping.statusCode).toBe(201);
    const mappingProfileId = mapping.json<{ id: string }>().id;
    harness.ocr.setText(SAMPLE_INVOICE_TEXT);
    const upload = await uploadDocument(harness, account, {
      content: fakePng('mapping-collision'),
    });
    const documentId = upload.json<{ id: string }>().id;
    await drainWorker(harness);
    await approveDocument(harness, account, documentId);
    for (const fieldMap of cases) {
      await harness.db.execute('UPDATE mapping_profiles SET field_map = ? WHERE id = ?', [
        JSON.stringify(fieldMap),
        mappingProfileId,
      ]);
      const send = await harness.api.json('POST', `/api/v1/documents/${documentId}/send`, {
        token: account.accessToken,
        body: { connectorId, mappingProfileId },
      });
      expect(send.statusCode).toBe(409);
      const preview = await harness.api.get(
        `/api/v1/documents/${documentId}/duplicates?connectorId=${connectorId}&mappingProfileId=${mappingProfileId}`,
        account.accessToken,
      );
      expect(preview.statusCode).toBe(409);
    }
    for (const malformed of ['{', '{}', '[null]', '[{}]']) {
      await harness.db.execute('UPDATE mapping_profiles SET field_map = ? WHERE id = ?', [
        malformed,
        mappingProfileId,
      ]);
      const send = await harness.api.json('POST', `/api/v1/documents/${documentId}/send`, {
        token: account.accessToken,
        body: { connectorId, mappingProfileId },
      });
      expect(send.statusCode).toBe(409);
      const preview = await harness.api.get(
        `/api/v1/documents/${documentId}/duplicates?connectorId=${connectorId}&mappingProfileId=${mappingProfileId}`,
        account.accessToken,
      );
      expect(preview.statusCode).toBe(409);
    }
    expect(create).not.toHaveBeenCalled();
    expect(read).not.toHaveBeenCalled();
    await harness.db.execute('UPDATE mapping_profiles SET field_map = ? WHERE id = ?', [
      JSON.stringify(valid),
      mappingProfileId,
    ]);
    const send = await harness.api.json('POST', `/api/v1/documents/${documentId}/send`, {
      token: account.accessToken,
      body: { connectorId, mappingProfileId },
    });
    expect(send.statusCode).toBe(202);
    expect(read).toHaveBeenCalledTimes(1);
    expect(create).toHaveBeenCalledTimes(1);
    expect(create.mock.calls[0]![0]).toEqual([{ values: { InvoiceNumber: 'INV-1042' } }]);
  } finally {
    await harness.close();
  }
}, 30_000);
