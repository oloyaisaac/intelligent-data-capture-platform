import {
  canApprove,
  parseMoney,
  formatMoney,
  parseDocumentDate,
  parseUdm,
  requiresReview,
  lowConfidenceFields,
  summariseUdm,
  toCsv,
  parseCsv,
  defuseFormula,
  buildPairingQrPayload,
  parsePairingQrPayload,
  findBestDuplicate,
  matchDuplicate,
  mergeRecord,
  normaliseKeyValue,
  similarity,
  parseCsv as parseCsvAlias,
  createTranslator,
  translationCoverage,
  directionFor,
  isRtl,
  roleAtLeast,
  applyCorrections,
  partitionForBulkApprove,
  type Udm,
} from '../src/index';

const baseUdm = (overrides: Partial<Udm> = {}): Udm => ({
  udmVersion: '1.0',
  documentType: 'invoice',
  documentTypeConfidence: 0.95,
  source: { documentId: 'doc-1', pageCount: 1, provider: 'test' },
  fields: {
    'invoice.number': { value: 'INV-1042', confidence: 0.98, type: 'string' },
    'total.amount': { value: 1250000, confidence: 0.5, type: 'currency', currency: 'UGX' },
  },
  tables: [],
  needsReview: true,
  warnings: [],
  provenance: { provider: 'test' },
  ...overrides,
});

describe('Universal Data Model', () => {
  it('accepts a valid record', () => {
    const result = parseUdm(baseUdm());
    expect(result.documentType).toBe('invoice');
    expect(Object.keys(result.fields)).toHaveLength(2);
  });

  it('rejects an unknown document type with a readable message', () => {
    expect(() => parseUdm({ ...baseUdm(), documentType: 'passport' })).toThrow(
      /Invalid UDM payload/,
    );
  });

  it('rejects currency fields without a currency code', () => {
    const broken = baseUdm();
    delete (broken.fields['total.amount'] as { currency?: string }).currency;
    expect(() => parseUdm(broken)).toThrow(/currency is required/);
  });

  it('rejects a confidence outside 0..1', () => {
    const broken = baseUdm();
    broken.fields['invoice.number']!.confidence = 1.4;
    expect(() => parseUdm(broken)).toThrow(/Invalid UDM payload/);
  });

  it('rejects table rows whose width does not match the columns', () => {
    const broken = baseUdm({
      tables: [
        {
          name: 'line_items',
          columns: [
            { key: 'a', label: 'A', type: 'string' },
            { key: 'b', label: 'B', type: 'string' },
          ],
          rows: [['only-one-cell']],
        },
      ],
    });
    expect(() => parseUdm(broken)).toThrow(/has 1 cells but the table has 2 columns/);
  });

  it('rejects extra properties (strict schema)', () => {
    expect(() => parseUdm({ ...baseUdm(), injected: true })).toThrow(/Invalid UDM payload/);
  });

  it('flags review when a field is below the threshold', () => {
    expect(requiresReview(baseUdm())).toBe(true);
    const confident = baseUdm();
    confident.fields['total.amount']!.confidence = 0.99;
    confident.documentTypeConfidence = 0.99;
    expect(requiresReview(confident)).toBe(false);
  });

  it('lists low-confidence fields worst first', () => {
    const udm = baseUdm();
    udm.fields['supplier.name'] = { value: 'Acme', confidence: 0.2, type: 'string' };
    expect(lowConfidenceFields(udm)).toEqual(['supplier.name', 'total.amount']);
  });

  it('summarises without leaking values', () => {
    const summary = summariseUdm(baseUdm());
    expect(summary).toEqual({
      documentType: 'invoice',
      fieldCount: 2,
      tableCount: 0,
      needsReview: true,
      averageConfidence: 0.74,
    });
    expect(JSON.stringify(summary)).not.toContain('INV-1042');
  });
});

describe('review rules', () => {
  it('blocks approval while a low-confidence field is unresolved', () => {
    const result = canApprove(baseUdm());
    expect(result.ok).toBe(false);
    expect(result.blocking.map((field) => field.path)).toContain('total.amount');
  });

  it('allows approval once every field is confident', () => {
    const udm = baseUdm();
    udm.fields['total.amount']!.confidence = 0.99;
    expect(canApprove(udm).ok).toBe(true);
  });

  it('treats a missing required field as blocking', () => {
    const result = canApprove(baseUdm(), ['supplier.taxId']);
    expect(result.blocking.some((field) => field.reason === 'missing_value')).toBe(true);
  });

  it('applies corrections and marks the field as human-confirmed', () => {
    const { udm, applied } = applyCorrections(baseUdm(), [
      { fieldPath: 'total.amount', value: 1300000 },
    ]);
    expect(applied).toHaveLength(1);
    expect(applied[0]!.before?.value).toBe(1250000);
    expect(udm.fields['total.amount']).toMatchObject({
      value: 1300000,
      confidence: 1,
      corrected: true,
      needsReview: false,
    });
    expect(udm.needsReview).toBe(false);
  });

  it('skips unresolved records on bulk approve instead of approving them', () => {
    const ready = baseUdm({
      source: { documentId: 'doc-2', pageCount: 1, provider: 'test' },
      fields: { 'invoice.number': { value: 'INV-1', confidence: 0.99, type: 'string' } },
      needsReview: false,
    });
    const { approvable, skipped } = partitionForBulkApprove([
      { id: 'doc-1', udm: baseUdm() },
      { id: 'doc-2', udm: ready },
    ]);
    expect(approvable).toEqual(['doc-2']);
    expect(skipped).toHaveLength(1);
    expect(skipped[0]!.id).toBe('doc-1');
  });
});

describe('money parsing', () => {
  it('parses a currency code with thousands separators', () => {
    expect(parseMoney('UGX 1,250,000')).toEqual({ amount: 1250000, currency: 'UGX' });
  });

  it('parses a symbol', () => {
    expect(parseMoney('$1,234.56')).toEqual({ amount: 1234.56, currency: 'USD' });
  });

  it('parses a European decimal comma', () => {
    expect(parseMoney('EUR 99,99')).toEqual({ amount: 99.99, currency: 'EUR' });
  });

  it('parses European grouping with a trailing symbol', () => {
    expect(parseMoney('1.234,56 €')).toEqual({ amount: 1234.56, currency: 'EUR' });
  });

  it('parses a bare number when a default currency is supplied', () => {
    expect(parseMoney('2500', { defaultCurrency: 'KES' })).toEqual({
      amount: 2500,
      currency: 'KES',
    });
  });

  it('returns null rather than guessing when no currency is present', () => {
    expect(parseMoney('2500')).toBeNull();
    expect(parseMoney('')).toBeNull();
    expect(parseMoney('not a number')).toBeNull();
  });

  it('formats for display', () => {
    expect(formatMoney(1250000, 'UGX')).toBe('UGX 1,250,000');
    expect(formatMoney(1234.5, 'USD')).toBe('USD 1,234.50');
  });
});

describe('document dates', () => {
  it('parses ISO dates', () => {
    expect(parseDocumentDate('2026-10-26')).toEqual({ iso: '2026-10-26', ambiguous: false });
  });

  it('parses written months in both orders', () => {
    expect(parseDocumentDate('26 Oct 2026')).toEqual({ iso: '2026-10-26', ambiguous: false });
    expect(parseDocumentDate('October 26, 2026')).toEqual({ iso: '2026-10-26', ambiguous: false });
  });

  it('flags ambiguous numeric dates instead of guessing silently', () => {
    expect(parseDocumentDate('03/04/2026')).toEqual({ iso: '2026-04-03', ambiguous: true });
    expect(parseDocumentDate('26/10/2026')).toEqual({ iso: '2026-10-26', ambiguous: false });
    expect(parseDocumentDate('10/26/2026')).toEqual({ iso: '2026-10-26', ambiguous: false });
  });

  it('rejects impossible dates', () => {
    expect(parseDocumentDate('31/02/2026')).toBeNull();
  });
});

describe('CSV', () => {
  it('neutralises spreadsheet formula injection', () => {
    expect(defuseFormula('=1+1')).toBe("'=1+1");
    expect(defuseFormula('+SUM(A1)')).toBe("'+SUM(A1)");
    expect(defuseFormula('@cmd')).toBe("'@cmd");
    expect(defuseFormula('-2')).toBe("'-2");
    expect(defuseFormula('plain')).toBe('plain');
  });

  it('quotes delimiters, quotes and newlines', () => {
    const csv = toCsv(
      ['a', 'b'],
      [
        ['x,y', 'he said "hi"'],
        ['line\nbreak', '=1+1'],
      ],
    );
    expect(csv).toBe('a,b\r\n"x,y","he said ""hi"""\r\n"line\nbreak",\'=1+1\r\n');
  });

  it('round-trips through the parser', () => {
    const rows = [
      ['x,y', 'plain'],
      ['quote "inside"', 'new\nline'],
    ];
    const csv = toCsv(['c1', 'c2'], rows);
    expect(parseCsv(csv)).toEqual([['c1', 'c2'], ...rows]);
  });

  it('supports a BOM and a custom delimiter', () => {
    const csv = toCsv(['a', 'b'], [['1', '2']], { bom: true, delimiter: ';' });
    expect(csv.startsWith('\uFEFF')).toBe(true);
    expect(csv).toContain('a;b');
    expect(parseCsvAlias(csv, ';')).toEqual([
      ['a', 'b'],
      ['1', '2'],
    ]);
  });

  it('refuses rows that do not match the header width', () => {
    expect(() => toCsv(['a', 'b'], [['only-one']])).toThrow(/cells but 2 headers/);
  });

  it('writes numbers and booleans plainly', () => {
    const csv = toCsv(['n', 'b'], [[42, true]]);
    expect(csv).toBe('n,b\r\n42,true\r\n');
  });
});

describe('pairing QR payload', () => {
  it('round-trips a valid payload', () => {
    const token = 'a'.repeat(40);
    const payload = buildPairingQrPayload('https://api.example.com/api/v1', token);
    expect(parsePairingQrPayload(payload)).toEqual({
      endpoint: 'https://api.example.com/api/v1',
      token,
    });
  });

  it('rejects foreign or malformed payloads', () => {
    expect(parsePairingQrPayload('https://evil.example.com/pair?t=abc')).toBeNull();
    expect(parsePairingQrPayload('idcp://pair?e=https://api.example.com&t=short')).toBeNull();
    expect(parsePairingQrPayload('idcp://pair?e=https://api.example.com')).toBeNull();
    expect(parsePairingQrPayload('javascript:alert(1)')).toBeNull();
  });

  it('rejects plain HTTP for non-local endpoints', () => {
    const token = 'b'.repeat(40);
    expect(parsePairingQrPayload(`idcp://pair?e=http://api.example.com&t=${token}`)).toBeNull();
    expect(
      parsePairingQrPayload(`idcp://pair?e=http://localhost:4000/api/v1&t=${token}`),
    ).not.toBeNull();
  });
});

describe('duplicate detection', () => {
  it('normalises values for comparison', () => {
    expect(normaliseKeyValue('  INV-1042 / A ')).toBe('inv 1042 a');
    expect(normaliseKeyValue('ACME Ltd.')).toBe('acme ltd');
  });

  it('treats identical keys as duplicates', () => {
    const match = matchDuplicate({ invoice: 'INV-1042' }, { invoice: 'inv 1042' }, ['invoice']);
    expect(match.isDuplicate).toBe(true);
    expect(match.score).toBe(1);
  });

  it('finds the best fuzzy match when no key matches exactly', () => {
    const result = findBestDuplicate(
      { supplier: 'Acme Limited' },
      [{ supplier: 'Zenith Traders' }, { supplier: 'Acme Ltd' }],
      ['supplier'],
    );
    expect(result?.record.supplier).toBe('Acme Ltd');
    expect(result?.match.score).toBeGreaterThan(0.7);
  });

  it('returns null when nothing is close enough', () => {
    const result = findBestDuplicate({ supplier: 'Acme' }, [{ supplier: 'Zzz' }], ['supplier']);
    expect(result).toBeNull();
  });

  it('scores similarity symmetrically', () => {
    expect(similarity('abc', 'abd')).toBeCloseTo(2 / 3, 5);
    expect(similarity('abc', 'abc')).toBe(1);
    expect(similarity('', 'abc')).toBe(0);
  });
});

describe('i18n', () => {
  it('translates and interpolates', () => {
    const t = createTranslator('en');
    expect(t('pairing.expiresIn', { seconds: 42 })).toBe('Expires in 42s');
  });

  it('falls back to English for missing translations', () => {
    const t = createTranslator('sw');
    expect(t('action.save')).toBe('Hifadhi');
    expect(t('export.title')).toBe('Hamisha');
    // The fallback still works: a locale with no catalogue at all returns English, not the key.
    const empty = createTranslator('fr');
    expect(empty('action.save')).toBe('Enregistrer');
  });

  it('never returns undefined for an unknown key', () => {
    const t = createTranslator('fr');
    // @ts-expect-error deliberately wrong key
    expect(t('does.not.exist')).toBe('does.not.exist');
  });

  it('reports translation coverage for shipped locales', () => {
    // I18N-001: nothing ships half-translated — every key has an Swahili and a French string.
    expect(translationCoverage('en')).toBe(1);
    expect(translationCoverage('sw')).toBe(1);
    expect(translationCoverage('fr')).toBe(1);
  });

  it('decides text direction from the language, so an RTL catalogue needs no layout work', () => {
    expect(directionFor('en')).toBe('ltr');
    expect(directionFor('sw-KE')).toBe('ltr');
    expect(directionFor('fr')).toBe('ltr');
    expect(directionFor('ar')).toBe('rtl');
    expect(directionFor('ar-EG')).toBe('rtl');
    expect(directionFor('he')).toBe('rtl');
    expect(directionFor('FA_ir')).toBe('rtl');
    expect(isRtl('ur')).toBe(true);
    expect(isRtl('en')).toBe(false);
    // Unknown or missing languages are left-to-right rather than guessed.
    expect(directionFor(null)).toBe('ltr');
    expect(directionFor('')).toBe('ltr');
    expect(directionFor('tlh')).toBe('ltr');
  });

  it('interpolates parameters and leaves unknown keys visible', () => {
    expect(createTranslator('en')('review.confidence', { percent: 82 })).toBe('Confidence 82%');
    expect(createTranslator('fr')('review.confidence', { percent: 82 })).toContain('82');
    // A missing key returns the key, which is how a half-finished translation announces itself.
    expect(createTranslator('sw')('nothing.here' as never)).toBe('nothing.here');
  });
});

describe('roles', () => {
  it('orders roles by privilege', () => {
    expect(roleAtLeast('owner', 'admin')).toBe(true);
    expect(roleAtLeast('reviewer', 'admin')).toBe(false);
    expect(roleAtLeast('viewer', 'viewer')).toBe(true);
  });
});

describe('merge policy (DUP-001)', () => {
  it('takes incoming values for fields the existing row has not reviewed', () => {
    const merged = mergeRecord(
      { invoice_number: 'INV-1', total: 100, note: 'kept' },
      { invoice_number: 'INV-1', total: 250 },
      { keys: ['invoice_number'] },
    );
    expect(merged.values).toEqual({ invoice_number: 'INV-1', total: 250, note: 'kept' });
    expect(merged.changedFields).toEqual(['total']);
    expect(merged.conflicts).toEqual([]);
  });

  it('never overwrites a reviewed value, and says what it kept', () => {
    const merged = mergeRecord(
      { invoice_number: 'INV-1', total: 100, supplier: 'Acme Ltd' },
      { total: 250, supplier: 'Acme Limited' },
      { keys: ['invoice_number'], reviewedFields: ['supplier'] },
    );
    expect(merged.values.supplier).toBe('Acme Ltd');
    expect(merged.values.total).toBe(250);
    expect(merged.conflicts).toEqual([
      { field: 'supplier', kept: 'Acme Ltd', ignored: 'Acme Limited', reason: 'reviewed' },
    ]);
  });

  it('keeps existing values when the incoming field is empty, and never rewrites a key', () => {
    const merged = mergeRecord(
      { invoice_number: 'INV-1', total: 100 },
      { invoice_number: 'INV-9', total: null, supplier: '' },
      { keys: ['invoice_number'] },
    );
    expect(merged.values).toEqual({ invoice_number: 'INV-1', total: 100 });
    expect(merged.conflicts).toEqual([
      { field: 'invoice_number', kept: 'INV-1', ignored: 'INV-9', reason: 'key' },
    ]);
  });
});
