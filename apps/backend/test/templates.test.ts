import { createHarness, registerAccount, type Harness, type TestAccount } from './helpers';

/**
 * TPL-001 — document templates.
 *
 * The behaviour that matters: templates are versioned, disabling never loses history, and an
 * active template genuinely changes what extraction produces (missing fields are reported).
 */
describe('document templates', () => {
  let harness: Harness;
  let account: TestAccount;

  beforeAll(async () => {
    harness = await createHarness();
    account = await registerAccount(harness);
  });

  afterAll(async () => {
    await harness.close();
  });

  const create = (body: unknown) =>
    harness.api.json('POST', '/api/v1/templates', { token: account.accessToken, body });

  it('creates a template from scratch at version 1', async () => {
    const response = await create({
      name: 'Standard invoice',
      documentType: 'invoice',
      fields: [
        { path: 'invoice.number', label: 'Invoice number', type: 'string', required: true },
        { path: 'invoice.total', label: 'Total', type: 'currency', required: true },
      ],
    });

    expect(response.statusCode).toBe(201);
    const template = response.json<{
      id: string;
      version: number;
      active: boolean;
      fields: unknown[];
    }>();
    expect(template.version).toBe(1);
    expect(template.active).toBe(true);
    expect(template.fields).toHaveLength(2);
  });

  it('rejects duplicate field paths and empty field lists', async () => {
    const duplicate = await create({
      name: 'Broken',
      documentType: 'invoice',
      fields: [
        { path: 'a', label: 'A', type: 'string', required: false },
        { path: 'a', label: 'A again', type: 'string', required: false },
      ],
    });
    expect(duplicate.statusCode).toBe(400);

    const empty = await create({ name: 'Empty', documentType: 'invoice', fields: [] });
    expect(empty.statusCode).toBe(400);
  });

  it('versions the field list and keeps every snapshot', async () => {
    const created = (
      await create({
        name: 'Receipt layout',
        documentType: 'receipt',
        fields: [{ path: 'receipt.total', label: 'Total', type: 'currency', required: true }],
      })
    ).json<{ id: string }>();

    const updated = await harness.api.json('PATCH', `/api/v1/templates/${created.id}`, {
      token: account.accessToken,
      body: {
        fields: [
          { path: 'receipt.total', label: 'Total', type: 'currency', required: true },
          { path: 'receipt.merchant', label: 'Merchant', type: 'string', required: false },
        ],
      },
    });
    expect(updated.statusCode).toBe(200);
    expect(updated.json<{ version: number }>().version).toBe(2);

    const detail = await harness.api.get(`/api/v1/templates/${created.id}`, account.accessToken);
    const body = detail.json<{ versions: Array<{ version: number; fields: unknown[] }> }>();
    expect(body.versions.map((version) => version.version)).toEqual([2, 1]);
    expect(body.versions[1]!.fields).toHaveLength(1);
  });

  it('disables a template without deleting its history', async () => {
    const created = (
      await create({
        name: 'Contract layout',
        documentType: 'contract',
        fields: [{ path: 'contract.parties', label: 'Parties', type: 'string', required: true }],
      })
    ).json<{ id: string }>();

    const deleted = await harness.api.json('DELETE', `/api/v1/templates/${created.id}`, {
      token: account.accessToken,
    });
    expect(deleted.statusCode).toBe(204);

    const detail = await harness.api.get(`/api/v1/templates/${created.id}`, account.accessToken);
    expect(detail.statusCode).toBe(200);
    expect(detail.json<{ active: boolean }>().active).toBe(false);
    expect(detail.json<{ versions: unknown[] }>().versions).toHaveLength(1);
  });

  it('reports a missing template as 404 rather than another organisation’s template', async () => {
    const other = await registerAccount(harness, {
      email: 'other-templates@example.com',
      organisationName: 'Other Co',
    });
    const response = await harness.api.get(
      '/api/v1/templates/00000000-0000-4000-8000-000000000000',
      other.accessToken,
    );
    expect(response.statusCode).toBe(404);
  });

  it('is used by extraction: a template field the OCR cannot find is reported, not dropped', async () => {
    await create({
      name: 'Invoice with PO',
      documentType: 'invoice',
      fields: [
        { path: 'invoice.number', label: 'Invoice number', type: 'string', required: true },
        { path: 'invoice.purchase_order', label: 'Purchase order', type: 'string', required: true },
      ],
    });

    harness.ocr.setText(
      'ACME SUPPLIES LTD\nInvoice No: INV-2024-0042\nInvoice Date: 2024-03-05\nTotal: USD 1,250.00',
    );

    const upload = await harness.api.upload(account.accessToken, { documentType: 'invoice' });
    expect(upload.statusCode).toBe(201);
    const documentId = upload.json<{ id: string }>().id;

    await harness.services.worker.drain();

    const result = await harness.api.get(
      `/api/v1/documents/${documentId}/result`,
      account.accessToken,
    );
    expect(result.statusCode).toBe(200);
    const body = result.json<{
      extraction: {
        udm: { fields: Record<string, { value: unknown; confidence: number }> };
      } | null;
    }>();

    const fields = body.extraction!.udm.fields;
    expect(fields['invoice.number']?.value).toBeTruthy();
    // The template expects a purchase order that is not on the page.
    expect(fields['invoice.purchase_order']).toBeDefined();
    expect(fields['invoice.purchase_order']!.value).toBeNull();
    expect(fields['invoice.purchase_order']!.confidence).toBe(0);

    // And therefore the record cannot be approved until a person supplies it.
    const review = await harness.api.json('POST', `/api/v1/documents/${documentId}/review`, {
      token: account.accessToken,
      body: {},
    });
    const reviewId = review.json<{ reviewId: string; blocking: Array<{ path: string }> }>()
      .reviewId;
    expect(
      review.json<{ blocking: Array<{ path: string }> }>().blocking.map((entry) => entry.path),
    ).toContain('invoice.purchase_order');

    const approve = await harness.api.json('POST', `/api/v1/review/${reviewId}/approve`, {
      token: account.accessToken,
      body: {},
    });
    expect(approve.statusCode).toBe(422);

    const patched = await harness.api.json('PATCH', `/api/v1/review/${reviewId}/fields`, {
      token: account.accessToken,
      body: { changes: [{ fieldPath: 'invoice.purchase_order', value: 'PO-7781' }] },
    });
    expect(patched.statusCode).toBe(200);
  });
});
