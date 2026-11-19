import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseCsv, parsePairingQrPayload } from '@idcp/shared';
import {
  createHarness,
  drainWorker,
  fakePng,
  openReview,
  registerAccount,
  SAMPLE_INVOICE_TEXT,
} from './helpers';

/** Synthetic backend replay of ARCHITECTURE.md §3, not a native-client or production pilot. */
it('pairs, accepts a device upload once, reviews, exports and sends the approved record', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'idcp-flow-'));
  const harness = await createHarness().catch(async (error: unknown) => {
    await rm(directory, { recursive: true, force: true });
    throw error;
  });
  let unsubscribe: (() => void) | undefined;
  try {
    const account = await registerAccount(harness);
    const events: string[] = [];
    unsubscribe = harness.hub.subscribe({ organisationId: account.organisationId }, (event) => {
      events.push(event);
    });

    const session = await harness.api.json('POST', '/api/v1/pairing/sessions', {
      token: account.accessToken,
    });
    expect(session.statusCode).toBe(201);
    const qr = parsePairingQrPayload(session.json<{ qrPayload: string }>().qrPayload);
    expect(qr?.token).toBeTruthy();
    const pairing = await harness.api.json('POST', '/api/v1/pairing/complete', {
      body: {
        token: qr!.token,
        device: { name: 'Test phone', platform: 'android', appVersion: '0.1.0' },
      },
    });
    expect(pairing.statusCode).toBe(201);
    const credential = pairing.json<{ deviceCredential: string }>().deviceCredential;
    expect(events).toContain('device:paired');

    const content = fakePng('architecture-replay');
    const upload = async () => {
      const form = new FormData();
      form.append(
        'file',
        new Blob([new Uint8Array(content)], { type: 'image/png' }),
        'invoice.png',
      );
      const response = await fetch(`${harness.baseUrl}/api/v1/documents`, {
        method: 'POST',
        headers: { 'x-device-credential': credential, 'idempotency-key': 'flow-upload-001' },
        body: form,
      });
      return {
        status: response.status,
        body: (await response.json()) as { id: string; duplicate: boolean },
      };
    };
    const first = await upload();
    const repeat = await upload();
    expect(first.status).toBe(201);
    expect(repeat.status).toBe(200);
    expect(repeat.body).toMatchObject({ id: first.body.id, duplicate: true });
    const documentId = first.body.id;
    expect(events).toContain('document:queued');
    const file = await harness.api.download(
      `/api/v1/documents/${documentId}/file`,
      account.accessToken,
    );
    expect(file.statusCode).toBe(200);
    expect(file.buffer()).toEqual(content);

    harness.ocr.setText(SAMPLE_INVOICE_TEXT);
    await drainWorker(harness);
    expect(harness.ocr.calls).toBe(1);
    expect(events).toContain('document:extracted');
    const review = await openReview(harness, account, documentId);
    const changes = [
      { fieldPath: 'invoice.number', value: 'INV-CORRECTED' },
      ...review.blocking
        .filter((field) => field.path !== 'documentType' && field.path !== 'invoice.number')
        .map((field) => ({ fieldPath: field.path, value: 'confirmed' })),
    ];
    const patched = await harness.api.json('PATCH', `/api/v1/review/${review.reviewId}/fields`, {
      token: account.accessToken,
      body: { changes, documentType: review.documentType },
    });
    expect(patched.statusCode).toBe(200);
    const approved = await harness.api.json('POST', `/api/v1/review/${review.reviewId}/approve`, {
      token: account.accessToken,
      body: {},
    });
    expect(approved.statusCode).toBe(200);
    expect(events).toContain('document:approved');
    const retryAfterApproval = await upload();
    expect(retryAfterApproval.status).toBe(200);
    await drainWorker(harness);
    expect(harness.ocr.calls).toBe(1);
    const afterRetry = await harness.api.get(
      `/api/v1/documents/${documentId}`,
      account.accessToken,
    );
    expect(afterRetry.json<{ status: string }>().status).toBe('approved');

    const exportResponse = await harness.api.json('POST', '/api/v1/exports', {
      token: account.accessToken,
      body: { format: 'csv', columns: ['invoice.number'] },
    });
    expect(exportResponse.statusCode).toBe(201);
    const exportId = exportResponse.json<{ id: string }>().id;
    const exported = await harness.api.download(
      `/api/v1/exports/${exportId}/download`,
      account.accessToken,
    );
    expect(exported.statusCode).toBe(200);
    expect(parseCsv(exported.body)).toContainEqual([documentId, 'invoice', 'INV-CORRECTED']);

    const connector = await harness.api.json('POST', '/api/v1/connectors', {
      token: account.accessToken,
      body: {
        type: 'csv',
        name: 'Replay destination',
        config: { directory, filename: 'output.csv' },
      },
    });
    expect(connector.statusCode).toBe(201);
    const connectorId = connector.json<{ id: string }>().id;
    const mapping = await harness.api.json('POST', '/api/v1/mapping-profiles', {
      token: account.accessToken,
      body: {
        connectorId,
        documentType: 'invoice',
        name: 'Replay invoice mapping',
        fieldMap: [
          { udmPath: 'invoice.number', destinationField: 'InvoiceNumber', transform: 'trim' },
        ],
        duplicatePolicy: 'append',
        duplicateKeys: [],
      },
    });
    expect(mapping.statusCode).toBe(201);
    const send = await harness.api.json('POST', `/api/v1/documents/${documentId}/send`, {
      token: account.accessToken,
      body: { connectorId, mappingProfileId: mapping.json<{ id: string }>().id },
    });
    expect(send.statusCode).toBe(202);
    expect(send.json<{ status: string }>().status).toBe('succeeded');
    expect(parseCsv(await readFile(join(directory, 'output.csv'), 'utf8'))).toEqual([
      ['InvoiceNumber'],
      ['INV-CORRECTED'],
    ]);
  } finally {
    unsubscribe?.();
    try {
      await harness.close();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
});
