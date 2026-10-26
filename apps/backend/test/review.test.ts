import {
  approveDocument,
  createHarness,
  drainWorker,
  fakePng,
  openReview,
  registerAccount,
  uploadDocument,
  SAMPLE_INVOICE_TEXT,
  type Harness,
} from './helpers';

describe('human-in-the-loop review (REV-001, REV-002)', () => {
  let harness: Harness;

  beforeAll(async () => {
    harness = await createHarness();
  });

  afterAll(async () => {
    await harness.close();
  });

  async function uploadAndProcess(ocrText = SAMPLE_INVOICE_TEXT) {
    const account = await registerAccount(harness);
    harness.ocr.setText(ocrText);
    const upload = await uploadDocument(harness, account, {
      content: fakePng(`review-${Math.random()}`),
    });
    const documentId = upload.json<{ id: string }>().id;
    await drainWorker(harness);
    return { account, documentId };
  }

  it('puts documents needing review in the queue, least confident first', async () => {
    const { account } = await uploadAndProcess();

    const queue = await harness.api.get('/api/v1/review/queue', account.accessToken);
    expect(queue.statusCode).toBe(200);
    const body = queue.json<{
      items: Array<{ confidence: number; blockingFields: unknown[] }>;
      total: number;
    }>();
    expect(body.total).toBeGreaterThan(0);

    const confidences = body.items.map((item) => item.confidence);
    expect([...confidences].sort((a, b) => a - b)).toEqual(confidences);
  });

  it('refuses approval while a field is unresolved, and says which', async () => {
    const { account, documentId } = await uploadAndProcess();
    const review = await openReview(harness, account, documentId);

    expect(review.blocking.length).toBeGreaterThan(0);

    const approve = await harness.api.json('POST', `/api/v1/review/${review.reviewId}/approve`, {
      token: account.accessToken,
      body: {},
    });
    expect(approve.statusCode).toBe(422);
    expect(approve.json<{ error: { code: string; details: unknown[] } }>().error.code).toBe(
      'UNPROCESSABLE',
    );

    const stillNeedsReview = await harness.db.one<{ status: string }>(
      'SELECT status FROM documents WHERE id = ?',
      [documentId],
    );
    expect(stillNeedsReview?.status).not.toBe('approved');
  });

  it('records every correction with before/after values and the reviewer (REV-002)', async () => {
    const { account, documentId } = await uploadAndProcess();
    const review = await openReview(harness, account, documentId);

    const target = review.blocking.find((field) => field.path !== 'documentType');
    expect(target).toBeDefined();

    const patched = await harness.api.json('PATCH', `/api/v1/review/${review.reviewId}/fields`, {
      token: account.accessToken,
      body: { changes: [{ fieldPath: target!.path, value: 'corrected-value' }] },
    });
    expect(patched.statusCode).toBe(200);

    const change = await harness.db.one<{
      field_path: string;
      corrected_value: string;
      changed_by: string;
      original_confidence: number;
    }>('SELECT * FROM review_changes WHERE review_id = ? AND field_path = ?', [
      review.reviewId,
      target!.path,
    ]);
    expect(change?.corrected_value).toBe('corrected-value');
    expect(change?.changed_by).toBe(account.userId);
    expect(change?.original_confidence).toBeGreaterThan(0);
  });

  it('approves once blockers are resolved and stores the approved snapshot', async () => {
    const { account, documentId } = await uploadAndProcess();

    await approveDocument(harness, account, documentId);

    const document = await harness.db.one<{ status: string }>(
      'SELECT status FROM documents WHERE id = ?',
      [documentId],
    );
    expect(document?.status).toBe('approved');

    const review = await harness.db.one<{ status: string; approved_udm: string }>(
      "SELECT status, approved_udm FROM reviews WHERE document_id = ? AND status = 'approved'",
      [documentId],
    );
    expect(review?.status).toBe('approved');
    const snapshot = JSON.parse(review!.approved_udm) as { needsReview: boolean };
    expect(snapshot.needsReview).toBe(false);
  });

  it('rejects a record with a reason and marks it failed', async () => {
    const { account, documentId } = await uploadAndProcess();
    const review = await openReview(harness, account, documentId);

    const rejected = await harness.api.json('POST', `/api/v1/review/${review.reviewId}/reject`, {
      token: account.accessToken,
      body: { reason: 'Illegible scan' },
    });
    expect(rejected.statusCode).toBe(200);

    const document = await harness.db.one<{ status: string }>(
      'SELECT status FROM documents WHERE id = ?',
      [documentId],
    );
    expect(document?.status).toBe('failed');
  });

  it('requires a reason to reject', async () => {
    const { account, documentId } = await uploadAndProcess();
    const review = await openReview(harness, account, documentId);
    const response = await harness.api.json('POST', `/api/v1/review/${review.reviewId}/reject`, {
      token: account.accessToken,
      body: {},
    });
    expect(response.statusCode).toBe(400);
  });

  it('bulk approve skips unresolved records instead of approving them', async () => {
    const { account } = await uploadAndProcess();

    // One document that will be clean after corrections, one left unresolved.
    harness.ocr.setText(`ACME SUPPLIES LIMITED
INVOICE
Invoice No: INV-9001
Date: 2026-10-20
Subtotal: UGX 100,000
VAT: UGX 18,000
Total: UGX 118,000`);
    const cleanUpload = await uploadDocument(harness, account, { content: fakePng('bulk-1') });
    const cleanId = cleanUpload.json<{ id: string }>().id;

    harness.ocr.setText(`UNREADABLE
some text without any labels at all`);
    const messyUpload = await uploadDocument(harness, account, { content: fakePng('bulk-2') });
    const messyId = messyUpload.json<{ id: string }>().id;

    await drainWorker(harness);

    // Resolve the clean one fully, leave the messy one alone.
    const cleanReview = await openReview(harness, account, cleanId);
    const changes = cleanReview.blocking
      .filter((field) => field.path !== 'documentType')
      .map((field) => ({ fieldPath: field.path, value: 'confirmed' }));
    const confirmType = cleanReview.blocking.some((field) => field.path === 'documentType');
    if (changes.length > 0 || confirmType) {
      await harness.api.json('PATCH', `/api/v1/review/${cleanReview.reviewId}/fields`, {
        token: account.accessToken,
        body: { changes, ...(confirmType ? { documentType: cleanReview.documentType } : {}) },
      });
    }

    const bulk = await harness.api.json('POST', '/api/v1/review/bulk-approve', {
      token: account.accessToken,
      body: { documentIds: [cleanId, messyId] },
    });
    expect(bulk.statusCode).toBe(200);
    const result = bulk.json<{ approved: string[]; skipped: Array<{ documentId: string }> }>();

    expect(result.approved).toContain(cleanId);
    expect(result.skipped.map((entry) => entry.documentId)).toContain(messyId);
    expect(result.approved).not.toContain(messyId);
  });

  it('cannot be used to review another organisation’s document', async () => {
    const { documentId } = await uploadAndProcess();
    const stranger = await registerAccount(harness, { email: 'review-stranger@example.com' });

    const response = await harness.api.json('POST', `/api/v1/documents/${documentId}/review`, {
      token: stranger.accessToken,
    });
    expect(response.statusCode).toBe(404);
  });

  it('refuses to patch a closed review', async () => {
    const { account, documentId } = await uploadAndProcess();
    await approveDocument(harness, account, documentId);

    const review = await harness.db.one<{ id: string }>(
      "SELECT id FROM reviews WHERE document_id = ? AND status = 'approved'",
      [documentId],
    );
    const response = await harness.api.json('PATCH', `/api/v1/review/${review!.id}/fields`, {
      token: account.accessToken,
      body: { changes: [{ fieldPath: 'total.amount', value: 1 }] },
    });
    expect(response.statusCode).toBe(409);
  });
});
