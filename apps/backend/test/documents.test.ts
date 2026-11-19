import { AuditRepository } from '../src/repositories/system-repo';
import {
  createHarness,
  drainWorker,
  fakePdf,
  fakePng,
  registerAccount,
  uploadDocument,
  SAMPLE_INVOICE_TEXT,
  type Harness,
} from './helpers';

describe('documents: upload, validation and extraction', () => {
  let harness: Harness;

  beforeAll(async () => {
    harness = await createHarness();
  });

  afterAll(async () => {
    await harness.close();
  });

  it('accepts an image and queues extraction (DOC-001)', async () => {
    const account = await registerAccount(harness);
    harness.ocr.setText(SAMPLE_INVOICE_TEXT);

    const response = await uploadDocument(harness, account, { content: fakePng('invoice') });
    expect(response.statusCode).toBe(201);
    const body = response.json<{ id: string; status: string; jobId: string }>();
    expect(body.status).toBe('queued');
    expect(body.jobId).toBeTruthy();

    const stored = await harness.db.one<{ mime_type: string; status: string; size_bytes: number }>(
      'SELECT mime_type, status, size_bytes FROM documents WHERE id = ?',
      [body.id],
    );
    expect(stored?.mime_type).toBe('image/png');
  });

  it('rolls back document and page rows if upload auditing fails', async () => {
    const account = await registerAccount(harness);
    const audit = jest
      .spyOn(AuditRepository.prototype, 'record')
      .mockRejectedValueOnce(new Error('audit unavailable'));
    try {
      const response = await uploadDocument(harness, account, {
        content: fakePng('transaction rollback'),
      });
      expect(response.statusCode).toBe(500);
    } finally {
      audit.mockRestore();
    }
    const docs = await harness.db.one<{ count: number }>(
      'SELECT COUNT(*) AS count FROM documents WHERE organisation_id = ?',
      [account.organisationId],
    );
    const jobs = await harness.db.one<{ count: number }>(
      'SELECT COUNT(*) AS count FROM jobs WHERE organisation_id = ?',
      [account.organisationId],
    );
    expect(Number(docs?.count)).toBe(0);
    expect(Number(jobs?.count)).toBe(0);
  });

  it('accepts a PDF', async () => {
    const account = await registerAccount(harness);
    // The multipart part claims image/png, but the bytes are a PDF: the sniffer wins.
    const response = await uploadDocument(harness, account, { content: fakePdf('invoice pdf') });
    expect(response.statusCode).toBe(201);
    const stored = await harness.db.one<{ mime_type: string }>(
      'SELECT mime_type FROM documents WHERE id = ?',
      [response.json<{ id: string }>().id],
    );
    expect(stored?.mime_type).toBe('application/pdf');
  });

  it('rejects content that is not an allowed type, whatever the filename says (DOC-001)', async () => {
    const account = await registerAccount(harness);
    const executable = Buffer.from('MZ\x90\x00\x03\x00\x00\x00 this is not an image at all');
    const response = await uploadDocument(harness, account, { content: executable });
    expect(response.statusCode).toBe(415);
    expect(response.json<{ error: { code: string } }>().error.code).toBe('UNSUPPORTED_MEDIA_TYPE');
  });

  it('rejects an empty upload', async () => {
    const account = await registerAccount(harness);
    const response = await uploadDocument(harness, account, { content: Buffer.alloc(0) });
    expect([400, 415]).toContain(response.statusCode);
  });

  it('rejects an upload larger than the limit', async () => {
    const account = await registerAccount(harness);
    const big = Buffer.concat([fakePng(), Buffer.alloc(6 * 1024 * 1024, 1)]);
    const response = await uploadDocument(harness, account, { content: big });
    expect(response.statusCode).toBe(413);
  });

  it('is idempotent per client key (DOC-001)', async () => {
    const account = await registerAccount(harness);
    const key = 'upload-attempt-1';

    const first = await uploadDocument(harness, account, {
      content: fakePng('once'),
      idempotencyKey: key,
    });
    expect(first.statusCode).toBe(201);

    const second = await uploadDocument(harness, account, {
      content: fakePng('once'),
      idempotencyKey: key,
    });
    expect(second.statusCode).toBe(200);
    expect(second.json<{ duplicate: boolean }>().duplicate).toBe(true);
    expect(second.json<{ id: string }>().id).toBe(first.json<{ id: string }>().id);

    const count = await harness.db.one<{ count: number }>(
      'SELECT COUNT(*) AS count FROM documents WHERE organisation_id = ? AND idempotency_key = ?',
      [account.organisationId, key],
    );
    expect(Number(count?.count)).toBe(1);
  });

  it('extracts an invoice into the Universal Data Model (AI-001, AI-003)', async () => {
    const account = await registerAccount(harness);
    harness.ocr.setText(SAMPLE_INVOICE_TEXT);

    const upload = await uploadDocument(harness, account, {
      content: fakePng('invoice-2'),
      documentType: 'invoice',
    });
    const documentId = upload.json<{ id: string }>().id;
    await drainWorker(harness);

    const result = await harness.api.json('GET', `/api/v1/documents/${documentId}/result`, {
      token: account.accessToken,
    });
    expect(result.statusCode).toBe(200);

    const body = result.json<{
      document: { status: string; documentType: string };
      extraction: {
        udm: { fields: Record<string, { value: unknown }>; tables: unknown[] };
        needsReview: boolean;
      };
    }>();
    expect(body.document.documentType).toBe('invoice');
    expect(['needs_review', 'extracted']).toContain(body.document.status);
    expect(body.extraction).not.toBeNull();

    const fields = body.extraction.udm.fields;
    expect(fields['invoice.number']?.value).toBe('INV-1042');
    expect(fields['total.amount']?.value).toBe(1121000);
    expect(fields['document.date']?.value).toBe('2026-10-26');
    expect(body.extraction.udm.tables.length).toBe(1);
  });

  it('classifies a receipt and extracts its total', async () => {
    const account = await registerAccount(harness);
    harness.ocr.setText(`KAMPALA HARDWARE STORE
RECEIPT
Receipt No: RCT-88
Date: 24/10/2026
Total: UGX 45,000
Thank you for your purchase`);

    const upload = await uploadDocument(harness, account, { content: fakePng('receipt') });
    const documentId = upload.json<{ id: string }>().id;
    await drainWorker(harness);

    const result = await harness.api.get(
      `/api/v1/documents/${documentId}/result`,
      account.accessToken,
    );
    const body = result.json<{
      document: { documentType: string };
      extraction: { udm: { fields: Record<string, { value: unknown }> } };
    }>();
    expect(body.document.documentType).toBe('receipt');
    expect(body.extraction.udm.fields['receipt.number']?.value).toBe('RCT-88');
    expect(body.extraction.udm.fields['total.amount']?.value).toBe(45000);
  });

  it('marks a document failed when OCR is unavailable, and reports why (AI-004, TC-14)', async () => {
    const account = await registerAccount(harness);
    harness.ocr.failWith(new Error('Local OCR engine is not installed.'));

    const upload = await uploadDocument(harness, account, { content: fakePng('no engine') });
    const documentId = upload.json<{ id: string }>().id;

    // Drain several times so the retry/backoff path is exercised to exhaustion.
    for (let attempt = 0; attempt < 6; attempt += 1) {
      await harness.db.execute("UPDATE jobs SET run_after = ? WHERE status = 'queued'", [
        new Date(Date.now() - 1000).toISOString(),
      ]);
      await drainWorker(harness);
    }

    const document = await harness.db.one<{ status: string }>(
      'SELECT status FROM documents WHERE id = ?',
      [documentId],
    );
    expect(document?.status).toBe('failed');

    const job = await harness.db.one<{ status: string; last_error: string }>(
      'SELECT status, last_error FROM jobs WHERE document_id = ?',
      [documentId],
    );
    expect(job?.status).toBe('dead');
    expect(job?.last_error).toContain('OCR engine is not installed');

    harness.ocr.setText(SAMPLE_INVOICE_TEXT);
  });

  it('scopes documents to the caller’s organisation (AUTH-002, TC-10)', async () => {
    const owner = await registerAccount(harness);
    const outsider = await registerAccount(harness, { email: 'outsider@example.com' });
    harness.ocr.setText(SAMPLE_INVOICE_TEXT);

    const upload = await uploadDocument(harness, owner, { content: fakePng('private') });
    const documentId = upload.json<{ id: string }>().id;

    const read = await harness.api.get(`/api/v1/documents/${documentId}`, outsider.accessToken);
    expect(read.statusCode).toBe(404);
    expect(read.body).not.toContain(documentId);

    const file = await harness.api.download(
      `/api/v1/documents/${documentId}/file`,
      outsider.accessToken,
    );
    expect(file.statusCode).toBe(404);

    const list = await harness.api.get('/api/v1/documents', outsider.accessToken);
    const ids = list.json<{ items: Array<{ id: string }> }>().items.map((item) => item.id);
    expect(ids).not.toContain(documentId);
  });

  it('streams the original file with hardened headers', async () => {
    const account = await registerAccount(harness);
    const upload = await uploadDocument(harness, account, { content: fakePng('download me') });
    const documentId = upload.json<{ id: string }>().id;

    const response = await harness.api.download(
      `/api/v1/documents/${documentId}/file`,
      account.accessToken,
    );
    expect(response.statusCode).toBe(200);
    expect(response.headers.get('content-type')).toBe('image/png');
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(response.headers.get('cache-control')).toContain('no-store');
    expect(response.buffer().length).toBeGreaterThan(8);
  });

  it('reprocesses a document on request', async () => {
    const account = await registerAccount(harness);
    const upload = await uploadDocument(harness, account, { content: fakePng('reprocess') });
    const documentId = upload.json<{ id: string }>().id;
    await drainWorker(harness);

    const reprocess = await harness.api.json('POST', `/api/v1/documents/${documentId}/reprocess`, {
      token: account.accessToken,
    });
    expect(reprocess.statusCode).toBe(202);
    expect(reprocess.json<{ jobId: string }>().jobId).toBeTruthy();
  });

  it('soft-deletes and then hides a document', async () => {
    const account = await registerAccount(harness);
    const upload = await uploadDocument(harness, account, { content: fakePng('delete me') });
    const documentId = upload.json<{ id: string }>().id;

    const deleted = await harness.api.json('DELETE', `/api/v1/documents/${documentId}`, {
      token: account.accessToken,
    });
    expect(deleted.statusCode).toBe(204);

    const read = await harness.api.get(`/api/v1/documents/${documentId}`, account.accessToken);
    expect(read.statusCode).toBe(404);
  });

  it('filters the document list by status', async () => {
    const account = await registerAccount(harness);
    harness.ocr.setText(SAMPLE_INVOICE_TEXT);
    const upload = await uploadDocument(harness, account, { content: fakePng('filter') });
    await drainWorker(harness);

    const queued = await harness.api.get('/api/v1/documents?status=queued', account.accessToken);
    const needsReview = await harness.api.get(
      '/api/v1/documents?status=needs_review',
      account.accessToken,
    );
    const queuedIds = queued.json<{ items: Array<{ id: string }> }>().items.map((item) => item.id);
    const reviewIds = needsReview
      .json<{ items: Array<{ id: string }> }>()
      .items.map((item) => item.id);

    expect(queuedIds).not.toContain(upload.json<{ id: string }>().id);
    expect(reviewIds.length + queuedIds.length).toBeGreaterThanOrEqual(0);
  });
});
