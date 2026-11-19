import { classifyDocument, isClassificationUncertain } from '../src/ai/classify';
import { extractFromText } from '../src/ai/extract';
import { parseTsv } from '../src/ai/providers/tesseract';
import { CloudVisionProvider } from '../src/ai/providers/cloud';
import { createLogger } from '../src/logger';
import { parseUdm } from '@idcp/shared';
import { SAMPLE_ID_TEXT, SAMPLE_INVOICE_TEXT, SAMPLE_RECEIPT_TEXT } from './helpers';

describe('document classification (AI-002)', () => {
  it('classifies an invoice', () => {
    const result = classifyDocument(SAMPLE_INVOICE_TEXT);
    expect(result.documentType).toBe('invoice');
    expect(result.confidence).toBeGreaterThan(0.5);
  });

  it('classifies a receipt', () => {
    const result = classifyDocument(SAMPLE_RECEIPT_TEXT);
    expect(result.documentType).toBe('receipt');
  });

  it('classifies an identity document', () => {
    const result = classifyDocument(SAMPLE_ID_TEXT);
    expect(result.documentType).toBe('id');
  });

  it('classifies a contract', () => {
    const result = classifyDocument(
      `SERVICE AGREEMENT

This agreement is made between Party A and Party B.
Both parties agree to the terms below.
Signed: ____________  Witness: ____________`,
    );
    expect(result.documentType).toBe('contract');
  });

  it('returns unknown with low confidence for empty or meaningless text', () => {
    expect(classifyDocument('').documentType).toBe('unknown');
    expect(classifyDocument('lorem ipsum dolor sit amet').documentType).toBe('unknown');
    expect(isClassificationUncertain(classifyDocument('lorem ipsum'))).toBe(true);
  });

  it('is honest about ties between document types', () => {
    const ambiguous = classifyDocument('INVOICE\nRECEIPT\nTotal: 100');
    // Both signals are strong, so confidence must be lower than a clean single-type document.
    expect(ambiguous.confidence).toBeLessThan(classifyDocument(SAMPLE_INVOICE_TEXT).confidence);
  });
});

describe('field and table extraction (AI-003)', () => {
  it('extracts invoice header fields with confidence', () => {
    const { fields } = extractFromText(SAMPLE_INVOICE_TEXT, 'invoice');
    expect(fields['invoice.number']?.value).toBe('INV-1042');
    expect(fields['document.date']?.value).toBe('2026-10-26');
    expect(fields['invoice.dueDate']?.value).toBe('2026-11-25');
    expect(fields['supplier.name']?.value).toContain('ACME');
    expect(fields['supplier.taxId']?.value).toBe('1001234567');
    expect(fields['customer.name']?.value).toBe('Demo Trading Ltd');
    for (const field of Object.values(fields)) {
      expect(field.confidence).toBeGreaterThan(0);
      expect(field.confidence).toBeLessThanOrEqual(1);
    }
  });

  it('extracts currency amounts with their currency code', () => {
    const { fields } = extractFromText(SAMPLE_INVOICE_TEXT, 'invoice');
    expect(fields['total.amount']).toMatchObject({
      value: 1121000,
      currency: 'UGX',
      type: 'currency',
    });
    expect(fields['subtotal.amount']).toMatchObject({ value: 950000, currency: 'UGX' });
    expect(fields['tax.amount']).toMatchObject({ value: 171000, currency: 'UGX' });
  });

  it('does not confuse the total with the subtotal', () => {
    const { fields } = extractFromText(SAMPLE_INVOICE_TEXT, 'invoice');
    expect(fields['total.amount']?.value).not.toBe(fields['subtotal.amount']?.value);
  });

  it('preserves the line-item table as structured rows', () => {
    const { tables } = extractFromText(SAMPLE_INVOICE_TEXT, 'invoice');
    expect(tables).toHaveLength(1);
    const table = tables[0]!;
    expect(table.columns.map((column) => column.key)).toEqual([
      'description',
      'quantity',
      'unit_price',
      'amount',
    ]);
    expect(table.rows).toHaveLength(2);
    expect(table.rows[0]).toEqual(['Cement 50kg bags', 10, 35000, 350000]);
  });

  it('extracts identity document fields', () => {
    const { fields } = extractFromText(SAMPLE_ID_TEXT, 'id');
    expect(fields['id.number']?.value).toBe('UG-123456789');
    expect(fields['person.surname']?.value).toBe('NAMONO');
    expect(fields['person.givenNames']?.value).toContain('Amina');
    expect(fields['person.dateOfBirth']?.value).toBe('1994-03-14');
  });

  it('captures generic label/value pairs from a form and marks them for review', () => {
    const { fields } = extractFromText(
      `APPLICATION FORM
Full Name: Amina Namono
District: Kampala
Occupation: Trader`,
      'form',
    );
    expect(fields['field.full_name']?.value).toBe('Amina Namono');
    expect(fields['field.district']?.value).toBe('Kampala');
    expect(fields['field.full_name']?.needsReview).toBe(true);
  });

  it('flags an ambiguous date instead of silently deciding', () => {
    const { fields, warnings } = extractFromText(
      `INVOICE
Invoice No: INV-7
Date: 03/04/2026
Total: UGX 500`,
      'invoice',
    );
    expect(fields['document.date']?.needsReview).toBe(true);
    expect(warnings.join(' ')).toMatch(/ambiguous/i);
  });

  it('warns when nothing could be read', () => {
    const { fields, warnings } = extractFromText('~~~~ ###', 'unknown');
    expect(Object.keys(fields)).toHaveLength(0);
    expect(warnings[0]).toMatch(/no fields/i);
  });

  it('produces records that validate against the UDM schema', () => {
    const { fields, tables } = extractFromText(SAMPLE_INVOICE_TEXT, 'invoice');
    const record = {
      udmVersion: '1.0',
      documentType: 'invoice',
      documentTypeConfidence: 0.9,
      source: { documentId: 'doc', pageCount: 1, provider: 'test' },
      fields,
      tables,
      needsReview: true,
      warnings: [],
      provenance: { provider: 'test' },
    };
    expect(() => parseUdm(record)).not.toThrow();
  });
});

describe('tesseract TSV parsing', () => {
  it('rebuilds lines and word boxes from TSV output', () => {
    const tsv = [
      'level\tpage_num\tblock_num\tpar_num\tline_num\tword_num\tleft\ttop\twidth\theight\tconf\ttext',
      '5\t1\t1\t1\t1\t1\t10\t10\t40\t12\t96\tINVOICE',
      '5\t1\t1\t1\t1\t2\t60\t10\t30\t12\t92\tNO',
      '5\t1\t1\t1\t2\t1\t10\t30\t60\t12\t88\tINV-1042',
    ].join('\n');

    const parsed = parseTsv(tsv);
    expect(parsed.text).toBe('INVOICE NO\nINV-1042');
    expect(parsed.words).toHaveLength(3);
    expect(parsed.words[0]).toMatchObject({ text: 'INVOICE', confidence: 0.96 });
    expect(parsed.words[0]?.bbox).toEqual({ x: 10, y: 10, width: 40, height: 12 });
  });

  it('ignores low-confidence and empty rows', () => {
    const tsv = [
      'level\tpage_num\tblock_num\tpar_num\tline_num\tword_num\tleft\ttop\twidth\theight\tconf\ttext',
      '5\t1\t1\t1\t1\t1\t0\t0\t1\t1\t-1\t',
      '5\t1\t1\t1\t1\t2\t0\t0\t1\t1\t90\tkept',
    ].join('\n');
    const parsed = parseTsv(tsv);
    expect(parsed.text).toBe('kept');
    expect(parsed.words).toHaveLength(1);
  });
});

describe('cloud OCR cost reporting', () => {
  it('warns after an estimated cost exceeds the configured threshold, rather than enforcing a spending cap', async () => {
    const lines: string[] = [];
    const logger = createLogger({ level: 'warn', sink: (line) => lines.push(line) });
    const fetchImpl = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: 'invoice' } }],
        usage: { total_tokens: 100 },
      }),
    }) as unknown as typeof fetch;
    const provider = new CloudVisionProvider({
      endpoint: 'https://example.com/ocr',
      apiKey: 'test-key',
      model: 'test-model',
      maxCostMicrosPerDocument: 1,
      fetchImpl,
    });
    const result = await provider.ocr(
      { buffer: Buffer.from('synthetic'), mimeType: 'image/png' },
      { logger },
    );
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(result.costMicros).toBe(500);
    expect(result.text).toBe('invoice');
    expect(lines.join('\n')).toContain(
      'estimated cloud AI cost exceeded the configured warning threshold',
    );
  });
});
