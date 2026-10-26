import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { parseCsv } from '@idcp/shared';
import {
  ConnectorRegistry,
  CsvFileConnector,
  GoogleSheetsConnector,
  SqliteConnector,
  applyMapping,
  transformValue,
  type ConnectorContext,
  type MappedField,
} from '../src/index';

const logger = {
  info: () => undefined,
  warn: () => undefined,
  debug: () => undefined,
  error: () => undefined,
};

const context: ConnectorContext = { organisationId: 'org-1', logger };

describe('mapping and transforms (MAP-001)', () => {
  const mapping: MappedField[] = [
    {
      udmPath: 'invoice.number',
      destinationField: 'InvoiceNumber',
      transform: 'trim',
      required: true,
    },
    { udmPath: 'total.amount', destinationField: 'Total', transform: 'number', required: true },
    { udmPath: 'document.date', destinationField: 'Date', transform: 'date_iso' },
    { udmPath: 'supplier.name', destinationField: 'Supplier', transform: 'uppercase' },
    { udmPath: 'isPaid', destinationField: 'Paid', transform: 'boolean' },
  ];

  it('maps UDM paths to destination fields with transforms', () => {
    const { values, missingRequired } = applyMapping(
      {
        'invoice.number': '  INV-1  ',
        'total.amount': 1250000,
        'document.date': '26/10/2026',
        'supplier.name': 'acme ltd',
        isPaid: 'yes',
      },
      mapping,
    );

    expect(values).toEqual({
      InvoiceNumber: 'INV-1',
      Total: 1250000,
      Date: '2026-10-26',
      Supplier: 'ACME LTD',
      Paid: true,
    });
    expect(missingRequired).toEqual([]);
  });

  it('reports required fields that could not be filled', () => {
    const { values, missingRequired } = applyMapping({ 'supplier.name': 'x' }, mapping);
    expect(missingRequired).toEqual(['InvoiceNumber', 'Total']);
    expect(values.InvoiceNumber).toBeNull();
  });

  it('uses defaults before giving up on a required field', () => {
    const { values, missingRequired } = applyMapping({}, [
      {
        udmPath: 'total.amount',
        destinationField: 'Total',
        transform: 'number',
        defaultValue: 0,
        required: true,
      },
    ]);
    expect(values.Total).toBe(0);
    expect(missingRequired).toEqual([]);
  });

  it('never guesses at unparseable values', () => {
    expect(transformValue('not a date', 'date_iso')).toBeNull();
    expect(transformValue('twelve', 'number')).toBeNull();
    expect(transformValue('maybe', 'boolean')).toBeNull();
    expect(transformValue('1,250', 'number')).toBe(1250);
    expect(transformValue('NO', 'boolean')).toBe(false);
  });
});

describe('CSV connector', () => {
  const connector = new CsvFileConnector();

  it('validates configuration and refuses path traversal', () => {
    expect(() =>
      connector.validateConfig({ directory: '/tmp', filename: '../escape.csv' }),
    ).toThrow(/path segments/);
    expect(() => connector.validateConfig({ directory: '/tmp' })).toThrow(/filename/);
    expect(() => connector.validateConfig({ filename: 'a.csv' })).toThrow(/directory/);
  });

  it('writes a header and rows, then appends without duplicating headers', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'idcp-csv-'));
    const config = { directory, filename: 'out.csv' };

    await connector.create([{ values: { a: 1, b: 'x' } }], config, context);
    await connector.create([{ values: { a: 2, b: 'y' } }], config, context);

    const rows = parseCsv(await readFile(join(directory, 'out.csv'), 'utf8'));
    expect(rows).toEqual([
      ['a', 'b'],
      ['1', 'x'],
      ['2', 'y'],
    ]);
  });

  it('refuses to write columns the existing file does not have', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'idcp-csv-'));
    const config = { directory, filename: 'fixed.csv' };
    await connector.create([{ values: { a: 1 } }], config, context);
    await expect(connector.create([{ values: { c: 3 } }], config, context)).rejects.toThrow(
      /different columns/,
    );
  });

  it('reads back what it wrote, with filters', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'idcp-csv-'));
    const config = { directory, filename: 'read.csv' };
    await connector.create(
      [{ values: { id: 'a', v: 1 } }, { values: { id: 'b', v: 2 } }],
      config,
      context,
    );

    const all = await connector.read({}, config, context);
    expect(all).toHaveLength(2);

    const filtered = await connector.read({ where: { id: 'b' } }, config, context);
    expect(filtered).toEqual([{ values: { id: 'b', v: '2' } }]);
  });

  it('passes its health check', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'idcp-csv-'));
    await expect(connector.healthCheck({ directory, filename: 'h.csv' }, context)).resolves.toEqual(
      { ok: true },
    );
    const bad = await connector.healthCheck({ directory, filename: 'a/b.csv' }, context);
    expect(bad.ok).toBe(false);
  });
});

describe('SQLite connector', () => {
  const connector = new SqliteConnector();

  it('inserts rows and reads them back', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'idcp-sqlite-'));
    const path = join(directory, 'dest.sqlite');
    const setup = new DatabaseSync(path);
    setup.exec('CREATE TABLE items (name TEXT, qty INTEGER)');
    setup.close();

    const config = { path, table: 'items' };
    const result = await connector.create(
      [{ values: { name: 'Cement', qty: 10 } }, { values: { name: 'Steel', qty: 5 } }],
      config,
      context,
    );
    expect(result.created).toBe(2);

    const rows = await connector.read({ limit: 10 }, config, context);
    expect(rows).toHaveLength(2);
    expect(rows[0]!.values.name).toBe('Cement');
  });

  it('describes the destination schema', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'idcp-sqlite-'));
    const path = join(directory, 'schema.sqlite');
    const setup = new DatabaseSync(path);
    setup.exec('CREATE TABLE invoices (invoice_number TEXT NOT NULL, total REAL)');
    setup.close();

    const schema = await connector.describeSchema({ path, table: 'invoices' }, context);
    expect(schema.fields).toEqual([
      { key: 'invoice_number', label: 'invoice_number', type: 'string', required: true },
      { key: 'total', label: 'total', type: 'number', required: false },
    ]);
  });

  it('rolls back the whole batch when one row fails', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'idcp-sqlite-'));
    const path = join(directory, 'rollback.sqlite');
    const setup = new DatabaseSync(path);
    setup.exec('CREATE TABLE strict_rows (name TEXT NOT NULL)');
    setup.close();

    const config = { path, table: 'strict_rows' };
    await expect(
      connector.create([{ values: { name: 'ok' } }, { values: { name: null } }], config, context),
    ).rejects.toThrow();

    const rows = await connector.read({ limit: 10 }, config, context);
    expect(rows).toHaveLength(0);
  });

  it('rejects identifiers that could inject SQL', async () => {
    expect(() =>
      connector.validateConfig({ path: ':memory:', table: 'items; DROP TABLE users' }),
    ).toThrow(/simple identifier/);
  });

  it('reports a clear error when the table is missing', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'idcp-sqlite-'));
    const result = await connector.healthCheck(
      { path: join(directory, 'empty.sqlite'), table: 'missing' },
      context,
    );
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/does not exist/i);
  });
});

describe('Google Sheets connector', () => {
  const connector = new GoogleSheetsConnector();
  const config = {
    spreadsheetId: '1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789',
    sheetName: 'Invoices',
    accessToken: 'ya29.token',
  };

  it('validates configuration', () => {
    expect(() => connector.validateConfig({ sheetName: 'x' })).toThrow(/spreadsheetId/);
    expect(() => connector.validateConfig({ spreadsheetId: 'short', sheetName: 'x' })).toThrow(
      /does not look like/,
    );
  });

  it('appends rows against existing headers', async () => {
    const calls: Array<{ url: string; method: string; body?: unknown }> = [];
    const fetchImpl = (async (_url: string, init?: RequestInit) => {
      calls.push({ url: String(_url), method: init?.method ?? 'GET', body: init?.body });
      if (!init?.method || init.method === 'GET') {
        return new Response(JSON.stringify({ values: [['InvoiceNumber', 'Total']] }), {
          status: 200,
        });
      }
      return new Response(JSON.stringify({}), { status: 200 });
    }) as unknown as typeof fetch;

    const result = await connector.create(
      [{ values: { InvoiceNumber: 'INV-1', Total: 100 } }],
      config,
      { ...context, fetchImpl },
    );

    expect(result.created).toBe(1);
    const append = calls.find((call) => call.method === 'POST');
    expect(append?.url).toContain(':append');
    expect(JSON.parse(String(append?.body)).values).toEqual([['INV-1', 100]]);
  });

  it('explains an expired token instead of leaking the API response', async () => {
    const fetchImpl = (async () => new Response('{}', { status: 401 })) as unknown as typeof fetch;
    await expect(
      connector.create([{ values: { a: 1 } }], config, { ...context, fetchImpl }),
    ).rejects.toThrow(/authorization expired/i);
  });

  it('refuses to write columns missing from the sheet', async () => {
    const fetchImpl = (async (_url: string, init?: RequestInit) => {
      if (!init?.method || init.method === 'GET') {
        return new Response(JSON.stringify({ values: [['InvoiceNumber']] }), { status: 200 });
      }
      return new Response('{}', { status: 200 });
    }) as unknown as typeof fetch;

    await expect(
      connector.create([{ values: { InvoiceNumber: 'x', Unexpected: 1 } }], config, {
        ...context,
        fetchImpl,
      }),
    ).rejects.toThrow(/missing these columns/i);
  });
});

describe('connector registry (CON-001)', () => {
  it('resolves known types and explains unknown ones', () => {
    const registry = new ConnectorRegistry();
    expect(registry.get('csv').type).toBe('csv');
    expect(registry.types()).toEqual(
      expect.arrayContaining(['csv', 'google_sheets', 'mysql', 'postgres', 'sqlite']),
    );
    expect(() => registry.get('sap')).toThrow(/Unsupported connector type "sap". Available:/);
  });

  it('exposes MySQL as its own connector with validated config', () => {
    const mysql = new ConnectorRegistry().get('mysql');
    expect(mysql.label).toMatch(/MySQL/);
    expect(() =>
      mysql.validateConfig({ connectionString: 'postgres://x', table: 'invoices' }),
    ).toThrow(/mysql:\/\//);
    expect(() =>
      mysql.validateConfig({ connectionString: 'mysql://user:pw@host/db', table: 'invoices' }),
    ).not.toThrow();
    // Identifiers cannot be parameterised, so they are rejected rather than escaped ad hoc.
    expect(() =>
      mysql.validateConfig({
        connectionString: 'mysql://user:pw@host/db',
        table: 'invoices; DROP',
      }),
    ).toThrow(/simple identifier/);
  });

  it('lists connectors with their capabilities', () => {
    const registry = new ConnectorRegistry();
    const sheets = registry.list().find((item) => item.type === 'google_sheets');
    expect(sheets?.capabilities).toEqual(expect.arrayContaining(['create', 'read']));
  });
});
