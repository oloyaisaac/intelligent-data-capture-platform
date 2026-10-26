import {
  LIMITS,
  parseDocumentDate,
  parseMoney,
  type DocumentType,
  type FieldValue,
  type UdmTable,
} from '@idcp/shared';

/**
 * Rule-based field and table extraction over OCR text (AI-003).
 *
 * Every field carries a confidence derived from the strength of the pattern that found it, so
 * the review UI can prioritise. Anything genuinely uncertain stays low-confidence on purpose —
 * a confidently wrong value is worse than a flagged one.
 */

export interface ExtractionOutput {
  fields: Record<string, FieldValue>;
  tables: UdmTable[];
  warnings: string[];
}

interface Candidate {
  strengths: number[];
  value: string | number;
  type?: FieldValue['type'];
  currency?: string;
  label?: string;
  needsReview?: boolean;
}

class FieldCollector {
  readonly fields: Record<string, FieldValue> = {};

  add(path: string, candidate: Candidate): void {
    if (path in this.fields) return; // first (strongest) match wins
    const confidence = Number(
      Math.min(
        0.99,
        candidate.strengths.reduce((sum, value) => sum + value, 0),
      ).toFixed(3),
    );
    this.fields[path] = {
      value: candidate.value,
      type: candidate.type ?? 'string',
      confidence,
      ...(candidate.label ? { label: candidate.label } : {}),
      ...(candidate.currency ? { currency: candidate.currency } : {}),
      ...(candidate.needsReview || confidence < LIMITS.reviewConfidenceThreshold
        ? { needsReview: true }
        : {}),
    };
  }
}

const STOP_LABELS =
  /^(invoice|receipt|tax invoice|date|total|subtotal|sub-total|amount|vat|tax|balance|due|page|tel|phone|email|www)/i;

function lines(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

function firstMatch(text: string, patterns: RegExp[]): { value: string; strength: number } | null {
  for (const [index, pattern] of patterns.entries()) {
    const match = text.match(pattern);
    const captured = match?.[1]?.trim();
    if (captured) return { value: captured, strength: index === 0 ? 0.92 : 0.78 };
  }
  return null;
}

/** Find a currency amount near a label, using the label match to bound the search window. */
function amountNear(
  text: string,
  labelPattern: RegExp,
  options: { defaultCurrency?: string } = {},
): { amount: number; currency: string; strength: number } | null {
  const label = new RegExp(labelPattern.source, `${labelPattern.flags.replace('g', '')}g`);
  let match: RegExpExecArray | null;
  while ((match = label.exec(text)) !== null) {
    // Look at the remainder of the line after the label.
    const lineEnd = text.indexOf('\n', match.index);
    const slice = text.slice(match.index, lineEnd === -1 ? undefined : lineEnd);
    const candidates = slice.match(/(?:[A-Z]{3}\s*)?[$€£₦₵₹]?\s*\d[\d.,]*/g) ?? [];
    for (const candidate of candidates) {
      const parsed = parseMoney(candidate, { defaultCurrency: options.defaultCurrency });
      if (parsed && parsed.amount > 0) {
        return { ...parsed, strength: 0.9 };
      }
    }
  }
  return null;
}

function looksLikeCompanyName(line: string): boolean {
  if (STOP_LABELS.test(line)) return false;
  if (line.length < 3 || line.length > 80) return false;
  if (!/[A-Za-z]{2}/.test(line)) return false;
  return (
    /\b(ltd|limited|inc|llc|plc|co|corp|company|traders|enterprises|services|group|holdings|uganda|kenya|tanzania|rwanda)\b/i.test(
      line,
    ) || line === line.toUpperCase()
  );
}

function extractTable(tableText: string): UdmTable | null {
  const rows = lines(tableText).filter((line) => /(\d[\d.,]*\d)|(\d)\s*$/.test(line));
  const candidateRows = rows.filter((line) => (line.match(/\s{2,}/g) ?? []).length >= 1);
  if (candidateRows.length < 2) return null;

  const split = (line: string) =>
    line
      .split(/\s{2,}|\t+/)
      .map((cell) => cell.trim())
      .filter(Boolean);
  const headerLine = candidateRows[0]!;
  const hasHeader = /(description|item|qty|quantity|amount|price|total|unit)/i.test(headerLine);
  const columns = hasHeader
    ? split(headerLine).slice(0, 8)
    : ['description', 'quantity', 'unit_price', 'amount'].slice(0, split(candidateRows[0]!).length);

  const dataRows = (hasHeader ? candidateRows.slice(1) : candidateRows)
    .map((line) => {
      const cells = split(line);
      // Recombine leading text cells so each row matches the column count.
      if (cells.length > columns.length) {
        const overflow = cells.length - columns.length;
        const merged = [cells.slice(0, overflow + 1).join(' '), ...cells.slice(overflow + 1)];
        return merged;
      }
      return cells;
    })
    .filter((cells) => cells.length === columns.length)
    .map((cells) =>
      cells.map((cell) => {
        // Convert only when the entire cell is a number: "Cement 50kg" must stay text.
        const trimmed = cell.trim();
        if (!/^-?[\d.,]+$/.test(trimmed) || !/\d/.test(trimmed)) return cell;
        const value = Number(trimmed.replace(/,/g, ''));
        return Number.isFinite(value) ? value : cell;
      }),
    );

  if (dataRows.length === 0) return null;

  return {
    name: 'line_items',
    columns: columns.map((column, index) => ({
      key: (column || `column_${index + 1}`).toLowerCase().replace(/[^a-z0-9]+/g, '_'),
      label: column || `Column ${index + 1}`,
      type: 'string' as const,
    })),
    rows: dataRows,
  };
}

export function extractFromText(
  text: string,
  documentType: DocumentType,
  options: {
    defaultCurrency?: string;
    /** Template field list for this document type (TPL-001). */
    expectedFields?: Array<{
      path: string;
      label: string;
      type: string;
      required?: boolean;
    }> | null;
  } = {},
): ExtractionOutput {
  const collector = new FieldCollector();
  const warnings: string[] = [];
  const body = text.replace(/\u00a0/g, ' ');

  // --- Fields common to invoices, receipts and contracts -------------------
  const documentNumber = firstMatch(body, [
    /(?:invoice|receipt|document|order)\s*(?:no\.?|number|#)\s*[:#]?\s*([A-Z0-9][A-Z0-9/-]{2,})/i,
    /\b(?:inv|rcpt)[\s#:-]*([A-Z0-9][A-Z0-9/-]{2,})/i,
  ]);
  if (documentNumber) {
    const path = documentType === 'receipt' ? 'receipt.number' : 'invoice.number';
    collector.add(path, {
      ...documentNumber,
      strengths: [documentNumber.strength],
      label: 'Document number',
    });
  }

  const issueDate = firstMatch(body, [
    /(?:invoice|issue|receipt|document)\s*date\s*[:-]?\s*([0-9][0-9A-Za-z ,./-]{5,20})/i,
    /\bdate\s*[:-]\s*([0-9][0-9A-Za-z ,./-]{5,20})/i,
  ]);
  if (issueDate) {
    const parsed = parseDocumentDate(issueDate.value);
    if (parsed) {
      collector.add('document.date', {
        value: parsed.iso,
        type: 'date',
        strengths: [issueDate.strength - (parsed.ambiguous ? 0.3 : 0)],
        label: 'Date',
        needsReview: parsed.ambiguous,
      });
      if (parsed.ambiguous) warnings.push('Date format is ambiguous (day/month); please confirm.');
    } else {
      warnings.push('A date was found but could not be read.');
    }
  }

  const money = (path: string, label: RegExp, strength = 0.9) => {
    const found = amountNear(body, label, { defaultCurrency: options.defaultCurrency });
    if (!found) return;
    collector.add(path, {
      value: found.amount,
      type: 'currency',
      currency: found.currency,
      strengths: [Math.min(strength, found.strength)],
      label: path,
    });
  };

  money('total.amount', /\b(?:grand\s+total|total\s+amount|amount\s+due|total)\b/i, 0.92);
  money('subtotal.amount', /\b(?:sub\s*-?total|net\s+amount)\b/i, 0.85);
  money('tax.amount', /\b(?:vat|tax|gst)\b/i, 0.8);

  // --- Invoice-specific ----------------------------------------------------
  if (documentType === 'invoice' || documentType === 'receipt' || documentType === 'unknown') {
    const supplierLine = lines(body).slice(0, 6).find(looksLikeCompanyName);
    if (supplierLine) {
      collector.add('supplier.name', {
        value: supplierLine.replace(/\s{2,}.*$/, '').slice(0, 120),
        strengths: [0.8],
        label: 'Supplier',
      });
    }

    const billTo = firstMatch(body, [
      /\b(?:bill\s+to|customer|client|buyer)\s*[:-]\s*([^\n]{2,80})/i,
    ]);
    if (billTo) {
      collector.add('customer.name', { value: billTo.value, strengths: [0.85], label: 'Customer' });
    }

    const dueDate = firstMatch(body, [/\bdue\s+date\s*[:-]?\s*([0-9][0-9A-Za-z ,./-]{5,20})/i]);
    if (dueDate) {
      const parsed = parseDocumentDate(dueDate.value);
      if (parsed) {
        collector.add('invoice.dueDate', {
          value: parsed.iso,
          type: 'date',
          strengths: [0.8 - (parsed.ambiguous ? 0.25 : 0)],
          needsReview: parsed.ambiguous,
          label: 'Due date',
        });
      }
    }

    const taxId = firstMatch(body, [
      /\b(?:tin|vat\s*(?:no|number)|tax\s*id)\s*[:-]?\s*([A-Z0-9-]{5,20})/i,
    ]);
    if (taxId)
      collector.add('supplier.taxId', { value: taxId.value, strengths: [0.8], label: 'Tax ID' });
  }

  // --- ID documents --------------------------------------------------------
  if (documentType === 'id') {
    const idNumber = firstMatch(body, [
      /\b(?:document|id|passport|licen[cs]e)\s*(?:no\.?|number)\s*[:-]?\s*([A-Z0-9][A-Z0-9/-]{4,19})/i,
    ]);
    if (idNumber)
      collector.add('id.number', { value: idNumber.value, strengths: [0.9], label: 'ID number' });

    const surname = firstMatch(body, [/\bsurname\s*[:-]?\s*([A-Z][A-Za-z'-]{1,40})/i]);
    const given = firstMatch(body, [
      /\b(?:given\s+names?|first\s+name)\s*[:-]?\s*([A-Z][A-Za-z' -]{1,60})/i,
    ]);
    if (surname)
      collector.add('person.surname', {
        value: surname.value,
        strengths: [0.88],
        label: 'Surname',
      });
    if (given)
      collector.add('person.givenNames', {
        value: given.value,
        strengths: [0.85],
        label: 'Given names',
      });

    const dob = firstMatch(body, [
      /\b(?:date\s+of\s+birth|dob)\s*[:-]?\s*([0-9][0-9A-Za-z ,./-]{5,20})/i,
    ]);
    if (dob) {
      const parsed = parseDocumentDate(dob.value);
      if (parsed) {
        collector.add('person.dateOfBirth', {
          value: parsed.iso,
          type: 'date',
          strengths: [0.85 - (parsed.ambiguous ? 0.25 : 0)],
          needsReview: parsed.ambiguous,
          label: 'Date of birth',
        });
      }
    }
  }

  // --- Contracts -----------------------------------------------------------
  if (documentType === 'contract') {
    const parties = body.match(/\b(?:between|parties)\b[^\n]{5,120}/i);
    if (parties) {
      collector.add('contract.parties', {
        value: parties[0].replace(/^\s*(between|parties)\s*[:-]?\s*/i, '').slice(0, 200),
        strengths: [0.7],
        label: 'Parties',
      });
    }
    const effective = firstMatch(body, [
      /\b(?:effective|commencement)\s+date\s*[:-]?\s*([0-9][0-9A-Za-z ,./-]{5,20})/i,
    ]);
    if (effective) {
      const parsed = parseDocumentDate(effective.value);
      if (parsed) {
        collector.add('contract.effectiveDate', {
          value: parsed.iso,
          type: 'date',
          strengths: [0.75 - (parsed.ambiguous ? 0.2 : 0)],
          needsReview: parsed.ambiguous,
          label: 'Effective date',
        });
      }
    }
  }

  // --- Generic key/value pairs (forms and unknown documents) --------------
  const keyValueFields: Record<string, FieldValue> = {};
  for (const line of lines(body)) {
    const match = line.match(/^([A-Za-z][A-Za-z0-9 /&()'-]{1,40})\s*:\s*(.{1,120})$/);
    if (!match) continue;
    const label = match[1]!.trim();
    const value = match[2]!.trim();
    if (!value || STOP_LABELS.test(label)) continue;
    const path = `field.${label
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_|_$/g, '')}`;
    if (path === 'field.' || path in collector.fields || path in keyValueFields) continue;
    keyValueFields[path] = { value, type: 'string', confidence: 0.72, needsReview: true, label };
  }
  for (const [path, field] of Object.entries(keyValueFields)) {
    if (!(path in collector.fields)) collector.fields[path] = field;
  }

  // --- Tables --------------------------------------------------------------
  const tables: UdmTable[] = [];
  const table = extractTable(body);
  if (table) tables.push(table);

  // --- Template expectations (TPL-001) ------------------------------------
  // A template field the extractor did not find is reported as missing with zero confidence, so
  // it reaches a reviewer instead of silently disappearing from the record.
  if (options.expectedFields && options.expectedFields.length > 0) {
    for (const expected of options.expectedFields) {
      if (expected.path in collector.fields) {
        // Keep the extracted value but adopt the template's label and declared type.
        const existing = collector.fields[expected.path]!;
        collector.fields[expected.path] = {
          ...existing,
          label: expected.label,
          type: existing.type === 'string' ? (expected.type as FieldValue['type']) : existing.type,
        };
        continue;
      }
      collector.fields[expected.path] = {
        label: expected.label,
        value: null,
        type: expected.type as FieldValue['type'],
        confidence: 0,
        needsReview: true,
      };
      warnings.push(`"${expected.label}" was not found in this document.`);
    }
  }

  if (Object.keys(collector.fields).length === 0) {
    warnings.push(
      'No fields could be read from this document. Retake the photo or add the data manually.',
    );
  }

  return { fields: collector.fields, tables, warnings };
}
