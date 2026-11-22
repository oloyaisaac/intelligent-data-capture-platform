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

it('blocks sending and duplicate preview when a required transform cannot produce a value', async () => {
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
    const mapping = await harness.api.json('POST', '/api/v1/mapping-profiles', {
      token: account.accessToken,
      body: {
        connectorId,
        documentType: 'invoice',
        name: 'invalid required boolean',
        fieldMap: [
          {
            udmPath: 'invoice.number',
            destinationField: 'Paid',
            transform: 'boolean',
            required: true,
          },
        ],
        duplicatePolicy: 'append',
      },
    });
    expect(mapping.statusCode).toBe(201);
    const mappingProfileId = mapping.json<{ id: string }>().id;
    harness.ocr.setText(SAMPLE_INVOICE_TEXT);
    const upload = await uploadDocument(harness, account, {
      content: fakePng('required-transform'),
    });
    const documentId = upload.json<{ id: string }>().id;
    await drainWorker(harness);
    await approveDocument(harness, account, documentId);
    const send = await harness.api.json('POST', `/api/v1/documents/${documentId}/send`, {
      token: account.accessToken,
      body: { connectorId, mappingProfileId },
    });
    expect(send.statusCode).toBe(422);
    const preview = await harness.api.get(
      `/api/v1/documents/${documentId}/duplicates?connectorId=${connectorId}&mappingProfileId=${mappingProfileId}`,
      account.accessToken,
    );
    expect(preview.statusCode).toBe(422);
    expect(create).not.toHaveBeenCalled();
    expect(read).not.toHaveBeenCalled();
  } finally {
    await harness.close();
  }
}, 30_000);
