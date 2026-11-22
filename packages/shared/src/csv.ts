/**
 * CSV writing with RFC 4180 quoting and spreadsheet formula-injection protection.
 * Used by EXPORT-002 and by the CSV connector.
 */

/** Leading control characters or formula markers (including after whitespace) are guarded. */
const FORMULA_CONTROL_PREFIXES = ['\t', '\r', '\n'];

export interface CsvOptions {
  delimiter?: ',' | ';' | '\t' | '|';
  /** Prefix the file with a UTF-8 BOM so Excel detects the encoding. */
  bom?: boolean;
  /** Neutralise formula-like text in headers and cells (default true). Never disable in production. */
  escapeFormulas?: boolean;
  /** Line ending. RFC 4180 uses CRLF; Excel on Windows expects it. */
  lineEnding?: '\r\n' | '\n';
}

/**
 * Neutralise a value that a spreadsheet could interpret as a formula.
 * Applied to headers and *text* cells only; real numbers are written unquoted and unaffected.
 * This is a conservative CSV mitigation, not a guarantee for every spreadsheet or import mode.
 */
export function defuseFormula(value: string): string {
  if (value.length === 0) return value;
  const first = value[0]!;
  if (FORMULA_CONTROL_PREFIXES.includes(first) || /^\s*[=+\-@]/u.test(value)) {
    // A leading apostrophe makes spreadsheets treat the cell as literal text.
    return `'${value}`;
  }
  return value;
}

/** Quote a field only when required by RFC 4180, doubling embedded quotes. */
export function escapeCsvField(value: string, delimiter = ','): string {
  const needsQuoting =
    value.includes(delimiter) ||
    value.includes('"') ||
    value.includes('\n') ||
    value.includes('\r') ||
    value !== value.trim();
  if (!needsQuoting) return value;
  return `"${value.replace(/"/g, '""')}"`;
}

export type CsvCell = string | number | boolean | null | undefined | Date;

function serialiseCell(
  cell: CsvCell,
  options: Required<Pick<CsvOptions, 'delimiter' | 'escapeFormulas'>>,
): string {
  if (cell === null || cell === undefined) return '';
  if (typeof cell === 'number') {
    if (!Number.isFinite(cell)) return '';
    return escapeCsvField(String(cell), options.delimiter);
  }
  if (typeof cell === 'boolean') return cell ? 'true' : 'false';
  if (cell instanceof Date) return escapeCsvField(cell.toISOString(), options.delimiter);

  const text = options.escapeFormulas ? defuseFormula(cell) : cell;
  return escapeCsvField(text, options.delimiter);
}

/** Serialise a full CSV document (headers + rows) as a string. */
export function toCsv(headers: string[], rows: CsvCell[][], options: CsvOptions = {}): string {
  const resolved = {
    delimiter: options.delimiter ?? ',',
    escapeFormulas: options.escapeFormulas ?? true,
  } as const;
  const lineEnding = options.lineEnding ?? '\r\n';

  const protectedHeaders = headers.map((header) =>
    resolved.escapeFormulas ? defuseFormula(header) : header,
  );
  // Escaping is not injective: "=x" and "'=x" both become "'=x". Do not silently
  // merge two distinct column identities in the serialized file.
  const headerOrigins = new Map<string, string>();
  for (let index = 0; index < headers.length; index++) {
    const output = protectedHeaders[index]!;
    const original = headers[index]!;
    if (headerOrigins.has(output) && headerOrigins.get(output) !== original) {
      throw new Error('CSV column names collide after formula protection.');
    }
    headerOrigins.set(output, original);
  }
  const lines: string[] = [];
  lines.push(
    protectedHeaders
      .map((header) => escapeCsvField(header, resolved.delimiter))
      .join(resolved.delimiter),
  );
  for (const row of rows) {
    if (row.length !== headers.length) {
      throw new Error(
        `CSV row has ${row.length} cells but ${headers.length} headers were provided`,
      );
    }
    lines.push(row.map((cell) => serialiseCell(cell, resolved)).join(resolved.delimiter));
  }

  const body = `${lines.join(lineEnding)}${lineEnding}`;
  return options.bom ? `\uFEFF${body}` : body;
}

/**
 * Minimal RFC 4180 parser (used by tests and by CSV import). Handles quoted fields,
 * embedded delimiters, doubled quotes and CRLF/LF line endings.
 */
export function parseCsv(input: string, delimiter = ','): string[][] {
  const text = input.replace(/^\uFEFF/, '');
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]!;

    if (inQuotes) {
      if (char === '"') {
        if (text[index + 1] === '"') {
          field += '"';
          index += 1;
        } else {
          inQuotes = false;
        }
      } else {
        field += char;
      }
      continue;
    }

    if (char === '"') {
      if (field.length > 0 && field.trim().length > 0) {
        // A quote inside an unquoted field is literal.
        field += char;
      } else {
        inQuotes = true;
        field = '';
      }
      continue;
    }

    if (char === delimiter) {
      row.push(field);
      field = '';
      continue;
    }

    if (char === '\r') {
      if (text[index + 1] === '\n') index += 1;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
      continue;
    }

    if (char === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
      continue;
    }

    field += char;
  }

  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }

  return rows.filter((entry) => !(entry.length === 1 && entry[0] === ''));
}
