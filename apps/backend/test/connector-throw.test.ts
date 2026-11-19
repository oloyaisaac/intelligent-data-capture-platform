import { ConnectorRegistry, type Connector } from '@idcp/connectors';
import { AppError } from '@idcp/shared';
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

/** This exercises an ordinary rejected connector operation, not process or security isolation. */
it('records connector write failures without exposing exception details and stays responsive', async () => {
  const secret = 'sensitive-connector-secret-123';
  const logLines: string[] = [];
  const create = jest
    .fn()
    .mockRejectedValueOnce(new Error(`Failed with credential ${secret}`))
    .mockRejectedValueOnce(new AppError('FORBIDDEN', `Denied ${secret}`))
    .mockRejectedValueOnce({ detail: secret });
  const connector: Connector = {
    type: 'csv', // The API currently only accepts the first-party type vocabulary.
    label: 'Throwing test connector',
    capabilities: ['create'],
    validateConfig: () => undefined,
    describeSchema: async () => ({ container: 'test', fields: [] }),
    healthCheck: async () => ({ ok: true }),
    create,
  };
  const logger = createLogger({ level: 'debug', sink: (line) => logLines.push(line) });
  const harness = await createHarness({}, { registry: new ConnectorRegistry([connector]), logger });
  try {
    const account = await registerAccount(harness);
    const created = await harness.api.json('POST', '/api/v1/connectors', {
      token: account.accessToken,
      body: { type: 'csv', name: 'Throwing destination', config: {} },
    });
    expect(created.statusCode).toBe(201);
    const connectorId = created.json<{ id: string }>().id;
    const mapping = await harness.api.json('POST', '/api/v1/mapping-profiles', {
      token: account.accessToken,
      body: {
        connectorId,
        documentType: 'invoice',
        name: 'Invoice mapping',
        fieldMap: [{ udmPath: 'invoice.number', destinationField: 'InvoiceNumber' }],
        duplicatePolicy: 'append',
        duplicateKeys: [],
      },
    });
    expect(mapping.statusCode).toBe(201);

    harness.ocr.setText(SAMPLE_INVOICE_TEXT);
    const upload = await uploadDocument(harness, account, {
      content: fakePng('throwing-connector'),
    });
    expect(upload.statusCode).toBe(201);
    const documentId = upload.json<{ id: string }>().id;
    await drainWorker(harness);
    await approveDocument(harness, account, documentId);

    const safeMessage =
      'Connector request failed. Check the destination for changes and review connection settings before retrying.';
    for (let i = 0; i < 3; i += 1) {
      const result = await harness.api.json('POST', `/api/v1/documents/${documentId}/send`, {
        token: account.accessToken,
        body: { connectorId, mappingProfileId: mapping.json<{ id: string }>().id },
      });
      expect(result.statusCode).toBe(422);
      expect(result.json()).toMatchObject({
        error: { code: 'UNPROCESSABLE', message: safeMessage },
      });
      expect(result.body).not.toContain(secret);
    }
    const failed = await harness.db.query<{ status: string; error: string }>(
      'SELECT status, error FROM connector_runs WHERE connector_id = ? AND document_id = ?',
      [connectorId, documentId],
    );
    expect(failed).toEqual(Array(3).fill({ status: 'failed', error: safeMessage }));
    const listed = await harness.api.get(
      `/api/v1/connectors/${connectorId}/runs`,
      account.accessToken,
    );
    expect(listed.statusCode).toBe(200);
    expect(listed.body).not.toContain(secret);
    expect(logLines.join('\n')).not.toContain(secret);
    expect(create).toHaveBeenCalledTimes(3);

    const read = jest.fn();
    const update = jest.fn().mockRejectedValue(new AppError('FORBIDDEN', `update ${secret}`));
    connector.read = read;
    connector.update = update;
    const updateMapping = await harness.api.json('POST', '/api/v1/mapping-profiles', {
      token: account.accessToken,
      body: {
        connectorId,
        documentType: 'invoice',
        name: 'Update mapping',
        fieldMap: [{ udmPath: 'invoice.number', destinationField: 'InvoiceNumber' }],
        duplicatePolicy: 'update',
        duplicateKeys: ['InvoiceNumber'],
      },
    });
    expect(updateMapping.statusCode).toBe(201);
    const sendUpdate = () =>
      harness.api.json('POST', `/api/v1/documents/${documentId}/send`, {
        token: account.accessToken,
        body: { connectorId, mappingProfileId: updateMapping.json<{ id: string }>().id },
      });
    read.mockRejectedValueOnce(new AppError('FORBIDDEN', `preview ${secret}`));
    const preview = await harness.api.get(
      `/api/v1/documents/${documentId}/duplicates?connectorId=${connectorId}&mappingProfileId=${updateMapping.json<{ id: string }>().id}`,
      account.accessToken,
    );
    expect(preview.statusCode).toBe(422);
    expect(preview.body).not.toContain(secret);
    read.mockRejectedValueOnce(new AppError('FORBIDDEN', `read ${secret}`));
    const readFailure = await sendUpdate();
    expect(readFailure.statusCode).toBe(422);
    expect(readFailure.body).not.toContain(secret);
    expect(readFailure.json()).toMatchObject({
      error: { code: 'UNPROCESSABLE', message: safeMessage },
    });

    read.mockResolvedValue([{ values: { InvoiceNumber: 'INV-1042' } }]);
    const updateFailure = await sendUpdate();
    expect(update).toHaveBeenCalledTimes(1);
    expect(updateFailure.statusCode).toBe(422);
    expect(updateFailure.body).not.toContain(secret);
    expect(updateFailure.json()).toMatchObject({
      error: { code: 'UNPROCESSABLE', message: safeMessage },
    });

    // This error is created by our own policy, not supplied by a connector.
    delete connector.update;
    const policyFailure = await sendUpdate();
    expect(policyFailure.statusCode).toBe(409);
    expect(policyFailure.json()).toMatchObject({
      error: { code: 'CONFLICT', message: expect.stringContaining('Change the duplicate policy') },
    });
    const allRuns = await harness.api.get(
      `/api/v1/connectors/${connectorId}/runs`,
      account.accessToken,
    );
    expect(allRuns.statusCode).toBe(200);
    expect(allRuns.json<{ items: unknown[] }>().items).toHaveLength(6);
    expect(allRuns.body).not.toContain(secret);
    const allStored = await harness.db.query<{ status: string; error: string }>(
      'SELECT status, error FROM connector_runs WHERE connector_id = ? AND document_id = ?',
      [connectorId, documentId],
    );
    expect(allStored).toHaveLength(6);
    expect(JSON.stringify(allStored)).not.toContain(secret);
    expect(logLines.join('\n')).not.toContain(secret);
    expect((await harness.api.json('GET', '/api/v1/health')).statusCode).toBe(200);
  } finally {
    await harness.close();
  }
});
