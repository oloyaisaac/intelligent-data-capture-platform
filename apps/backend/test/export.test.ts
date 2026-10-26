import ExcelJS from 'exceljs';
import { parseCsv } from '@idcp/shared';
import {
  approveDocument,
  createHarness,
  drainWorker,
  fakePng,
  registerAccount,
  uploadDocument,
  SAMPLE_INVOICE_TEXT,
  type Harness,
  type TestAccount,
} from './helpers';

describe('exports (EXPORT-001, EXPORT-002)', () => {
  let harness: Harness;

  beforeAll(async () => {
    harness = await createHarness();
  });

  afterAll(async () => {
    await harness.close();
  });

  async function approvedInvoice(
    account: TestAccount,
    text = SAMPLE_INVOICE_TEXT,
  ): Promise<string> {
    harness.ocr.setText(text);
    const upload = await uploadDocument(harness, account, {
      content: fakePng(`export-${Math.random()}`),
    });
    const documentId = upload.json<{ id: string }>().id;
    await drainWorker(harness);
    await approveDocument(harness, account, documentId);
    return documentId;
  }

  it('exports approved records as CSV with a stable header (EXPORT-002)', async () => {
    const account = await registerAccount(harness);
    const documentId = await approvedInvoice(account);

    const created = await harness.api.json('POST', '/api/v1/exports', {
      token: account.accessToken,
      body: { format: 'csv' },
    });
    expect(created.statusCode).toBe(201);
    const exportRecord = created.json<{ id: string; status: string; rowCount: number }>();
    expect(exportRecord.status).toBe('ready');
    expect(exportRecord.rowCount).toBeGreaterThanOrEqual(1);

    const download = await harness.api.download(
      `/api/v1/exports/${exportRecord.id}/download`,
      account.accessToken,
    );
    expect(download.statusCode).toBe(200);
    const rows = parseCsv(download.body);
    expect(rows[0]).toContain('document_id');
    expect(rows[0]).toContain('document_type');
    expect(rows.some((row) => row[0] === documentId)).toBe(true);
    expect(download.headers.get('content-disposition')).toContain('attachment');
  });

  it('neutralises spreadsheet formula injection in exported values', async () => {
    const account = await registerAccount(harness);
    harness.ocr.setText(`ACME SUPPLIES LIMITED
INVOICE
Invoice No: =1+1
Date: 2026-10-20
Total: UGX 10,000`);
    const upload = await uploadDocument(harness, account, { content: fakePng('formula') });
    const documentId = upload.json<{ id: string }>().id;
    await drainWorker(harness);

    // Force a formula-looking value through a human correction, the way a user could.
    const review = await harness.api.json('POST', `/api/v1/documents/${documentId}/review`, {
      token: account.accessToken,
    });
    const reviewBody = review.json<{
      reviewId: string;
      documentType: string;
      blocking: Array<{ path: string }>;
    }>();
    await harness.api.json('PATCH', `/api/v1/review/${reviewBody.reviewId}/fields`, {
      token: account.accessToken,
      body: {
        changes: [
          { fieldPath: 'invoice.number', value: '=1+1' },
          ...reviewBody.blocking
            .filter((field) => field.path !== 'documentType' && field.path !== 'invoice.number')
            .map((field) => ({ fieldPath: field.path, value: 'ok' })),
        ],
        documentType: reviewBody.documentType,
      },
    });
    const approve = await harness.api.json(
      'POST',
      `/api/v1/review/${reviewBody.reviewId}/approve`,
      {
        token: account.accessToken,
        body: {},
      },
    );
    expect(approve.statusCode).toBe(200);

    const created = await harness.api.json('POST', '/api/v1/exports', {
      token: account.accessToken,
      body: { format: 'csv' },
    });
    const exportId = created.json<{ id: string }>().id;
    const download = await harness.api.download(
      `/api/v1/exports/${exportId}/download`,
      account.accessToken,
    );

    expect(download.body).toContain("'=1+1");
    expect(download.body).not.toMatch(/(^|,)=1\+1/m);
  });

  it('writes a valid .xlsx workbook that opens in Excel', async () => {
    const account = await registerAccount(harness);
    await approvedInvoice(account);

    const created = await harness.api.json('POST', '/api/v1/exports', {
      token: account.accessToken,
      body: { format: 'xlsx' },
    });
    expect(created.statusCode).toBe(201);
    const exportId = created.json<{ id: string }>().id;

    const download = await harness.api.download(
      `/api/v1/exports/${exportId}/download`,
      account.accessToken,
    );
    expect(download.statusCode).toBe(200);

    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(download.buffer() as unknown as ArrayBuffer);
    const sheet = workbook.getWorksheet('Records');
    expect(sheet).toBeDefined();

    const header = (sheet!.getRow(1).values as unknown[]).slice(1).map(String);
    expect(header).toContain('document_id');
    expect(header).toContain('total.amount');
    expect(sheet!.rowCount).toBeGreaterThanOrEqual(2);
    expect(header.length).toBeGreaterThan(2);
  });

  it('produces a headers-only file when nothing matches', async () => {
    const account = await registerAccount(harness);
    const created = await harness.api.json('POST', '/api/v1/exports', {
      token: account.accessToken,
      body: { format: 'csv', documentType: 'contract' },
    });
    const exportId = created.json<{ id: string; rowCount: number }>().id;
    expect(created.json<{ rowCount: number }>().rowCount).toBe(0);

    const download = await harness.api.download(
      `/api/v1/exports/${exportId}/download`,
      account.accessToken,
    );
    const rows = parseCsv(download.body);
    expect(rows).toHaveLength(1);
    expect(rows[0]![0]).toBe('document_id');
  });

  it('honours a column projection', async () => {
    const account = await registerAccount(harness);
    await approvedInvoice(account);

    const created = await harness.api.json('POST', '/api/v1/exports', {
      token: account.accessToken,
      body: { format: 'csv', columns: ['total.amount', 'invoice.number'] },
    });
    const exportId = created.json<{ id: string }>().id;
    const download = await harness.api.download(
      `/api/v1/exports/${exportId}/download`,
      account.accessToken,
    );

    const header = parseCsv(download.body)[0]!;
    expect(header).toEqual(['document_id', 'document_type', 'total.amount', 'invoice.number']);
  });

  it('does not export records that are not approved yet', async () => {
    const account = await registerAccount(harness);
    harness.ocr.setText(SAMPLE_INVOICE_TEXT);
    const upload = await uploadDocument(harness, account, { content: fakePng('not approved') });
    const documentId = upload.json<{ id: string }>().id;
    await drainWorker(harness);

    const created = await harness.api.json('POST', '/api/v1/exports', {
      token: account.accessToken,
      body: { format: 'csv' },
    });
    const exportId = created.json<{ id: string }>().id;
    const download = await harness.api.download(
      `/api/v1/exports/${exportId}/download`,
      account.accessToken,
    );
    const ids = parseCsv(download.body).map((row) => row[0]);
    expect(ids).not.toContain(documentId);
  });

  it('scopes exports and downloads to the organisation', async () => {
    const owner = await registerAccount(harness);
    const stranger = await registerAccount(harness, { email: 'export-stranger@example.com' });
    await approvedInvoice(owner);

    const created = await harness.api.json('POST', '/api/v1/exports', {
      token: owner.accessToken,
      body: { format: 'csv' },
    });
    const exportId = created.json<{ id: string }>().id;

    const attempt = await harness.api.download(
      `/api/v1/exports/${exportId}/download`,
      stranger.accessToken,
    );
    expect(attempt.statusCode).toBe(404);

    const read = await harness.api.get(`/api/v1/exports/${exportId}`, stranger.accessToken);
    expect(read.statusCode).toBe(404);
  });

  it('rejects an unsupported format', async () => {
    const account = await registerAccount(harness);
    const response = await harness.api.json('POST', '/api/v1/exports', {
      token: account.accessToken,
      body: { format: 'pdf' },
    });
    expect(response.statusCode).toBe(400);
  });
});
