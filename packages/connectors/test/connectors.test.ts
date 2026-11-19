import { createServer } from 'node:http';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { parseCsv } from '@idcp/shared';
import {
  ConnectorRegistry,
  CsvFileConnector,
  GoogleSheetsConnector,
  HubSpotConnector,
  OdooConnector,
  QuickBooksConnector,
  SqliteConnector,
  type ConnectorContext,
  applyMapping,
  transformValue,
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

  it('updates existing rows by their duplicate keys (DUP-001)', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'idcp-update-'));
    const path = join(directory, 'dest.sqlite');
    const seed = new DatabaseSync(path);
    seed.exec('CREATE TABLE invoices (invoice_number TEXT, total REAL, note TEXT)');
    seed.prepare('INSERT INTO invoices VALUES (?, ?, ?)').run('INV-1', 100, 'untouched');
    seed.close();

    const connector = new SqliteConnector();
    const config = { path, table: 'invoices' };
    const updateContext: ConnectorContext = { organisationId: 'org-1', logger };

    const result = await connector.update!(
      [{ values: { invoice_number: 'INV-1', total: 250 } }],
      ['invoice_number'],
      config,
      updateContext,
    );
    expect(result.updated).toBe(1);
    expect(result.created).toBe(0);

    const check = new DatabaseSync(path);
    const row = check.prepare('SELECT total, note FROM invoices').get() as {
      total: number;
      note: string;
    };
    expect(row.total).toBe(250);
    // The update only touches mapped columns; nothing else is blanked.
    expect(row.note).toBe('untouched');
    check.close();
  });

  it('refuses an update without duplicate keys, and rejects unsafe identifiers', async () => {
    const connector = new SqliteConnector();
    const updateContext: ConnectorContext = { organisationId: 'org-1', logger };
    await expect(
      connector.update!(
        [{ values: { a: 1 } }],
        [],
        { path: ':memory:', table: 't' },
        updateContext,
      ),
    ).rejects.toThrow(/duplicate key/i);

    await expect(
      connector.update!(
        [{ values: { 'a; DROP TABLE t': 1 } }],
        ['invoice_number'],
        { path: ':memory:', table: 't' },
        updateContext,
      ),
    ).rejects.toThrow(/simple identifier/i);
  });
});

describe('CRM, ERP and accounting connectors (CRM-001)', () => {
  interface Recorded {
    method: string;
    url: string;
    body: unknown;
    auth: string | undefined;
  }

  /** A stub that answers like the vendor and records what was sent. */
  async function stubServer(
    handler: (recorded: Recorded) => { status: number; body: unknown },
  ): Promise<{
    baseUrl: string;
    fetchImpl: typeof fetch;
    calls: Recorded[];
    close: () => Promise<void>;
  }> {
    const calls: Recorded[] = [];
    const server = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on('data', (chunk: Buffer) => chunks.push(chunk));
      request.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        const recorded: Recorded = {
          method: request.method ?? 'GET',
          url: request.url ?? '/',
          body: raw ? (JSON.parse(raw) as unknown) : null,
          auth: request.headers.authorization,
        };
        calls.push(recorded);
        const { status, body } = handler(recorded);
        response.writeHead(status, { 'content-type': 'application/json' });
        response.end(JSON.stringify(body));
      });
    });

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    const port = typeof address === 'object' && address ? address.port : 0;
    return {
      baseUrl: 'https://connector.example',
      fetchImpl: ((input: string | URL | Request, init?: RequestInit) => {
        const url = String(input);
        if (!url.startsWith('https://connector.example/')) throw new Error('Unexpected test URL');
        return fetch(url.replace('https://connector.example', `http://127.0.0.1:${port}`), init);
      }) as typeof fetch,
      calls,
      close: () =>
        new Promise<void>((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
        }),
    };
  }

  const context: ConnectorContext = {
    organisationId: 'org-1',
    logger: { info: jest.fn(), warn: jest.fn(), debug: jest.fn(), error: jest.fn() },
  };

  it('creates, searches and updates a HubSpot record without a mapping change', async () => {
    const stub = await stubServer((recorded) => {
      if (recorded.url.includes('/search')) {
        return {
          status: 200,
          body: { results: [{ id: '42', properties: { invoice_number: 'INV-1' } }] },
        };
      }
      if (recorded.method === 'PATCH') return { status: 200, body: { id: '42' } };
      return { status: 201, body: { id: '42', properties: {} } };
    });

    try {
      const hubspot = new HubSpotConnector();
      const config = { baseUrl: stub.baseUrl, token: 'secret-token', object: 'invoices' };
      hubspot.validateConfig(config);

      const created = await hubspot.create(
        [{ values: { invoice_number: 'INV-1', total: 120 } }],
        config,
        { ...context, fetchImpl: stub.fetchImpl },
      );
      expect(created.created).toBe(1);
      expect(stub.calls[0]!.body).toEqual({
        properties: { invoice_number: 'INV-1', total: '120' },
      });
      expect(stub.calls[0]!.auth).toBe('Bearer secret-token');

      const found = await hubspot.search({ where: { invoice_number: 'INV-1' } }, config, {
        ...context,
        fetchImpl: stub.fetchImpl,
      });
      expect(found[0]!.values).toMatchObject({ id: '42', invoice_number: 'INV-1' });
      const searchCall = stub.calls.find((call) => call.url.includes('/search'));
      expect(searchCall!.body).toMatchObject({
        filterGroups: [
          { filters: [{ propertyName: 'invoice_number', operator: 'EQ', value: 'INV-1' }] },
        ],
      });

      const updated = await hubspot.update([{ values: { id: '42', total: 130 } }], ['id'], config, {
        ...context,
        fetchImpl: stub.fetchImpl,
      });
      expect(updated.updated).toBe(1);
      const patch = stub.calls.find((call) => call.method === 'PATCH');
      expect(patch!.url).toContain('/crm/v3/objects/invoices/42');
    } finally {
      await stub.close();
    }
  });

  it('explains a rejected HubSpot credential instead of surfacing a 401', async () => {
    const stub = await stubServer(() => ({
      status: 401,
      body: { status: 'error', message: 'Authentication credentials not found' },
    }));

    try {
      const hubspot = new HubSpotConnector();
      await expect(
        hubspot.create(
          [{ values: { invoice_number: 'INV-1' } }],
          { baseUrl: stub.baseUrl, token: 'bad', object: 'invoices' },
          { ...context, fetchImpl: stub.fetchImpl },
        ),
      ).rejects.toThrow(/rejected the credential.*write access/i);
    } finally {
      await stub.close();
    }
  });

  it('queries and sparsely updates QuickBooks, escaping the filter value', async () => {
    const stub = await stubServer((recorded) => {
      if (recorded.method === 'POST') return { status: 200, body: { Invoice: { Id: '9' } } };
      return {
        status: 200,
        body: { QueryResponse: { Invoice: [{ Id: '9', DocNumber: 'INV-1' }] } },
      };
    });

    try {
      const quickbooks = new QuickBooksConnector();
      const config = {
        baseUrl: stub.baseUrl,
        token: 'qbo-token',
        realmId: '934145',
        object: 'Invoice',
      };
      quickbooks.validateConfig(config);

      const found = await quickbooks.search({ where: { DocNumber: "INV-1'2" } }, config, {
        ...context,
        fetchImpl: stub.fetchImpl,
      });
      expect(found[0]!.values).toMatchObject({ Id: '9' });
      expect(stub.calls[0]!.url).toContain('/v3/company/934145/query?query=');
      expect(decodeURIComponent(stub.calls[0]!.url)).toContain("DocNumber = 'INV-1\\'2'");

      const updated = await quickbooks.update(
        [{ values: { Id: '9', TotalAmt: 55 } }],
        ['Id'],
        config,
        { ...context, fetchImpl: stub.fetchImpl },
      );
      expect(updated.updated).toBe(1);
      const post = stub.calls.find((call) => call.method === 'POST');
      expect(post!.body).toMatchObject({ Id: '9', sparse: true, TotalAmt: 55 });
    } finally {
      await stub.close();
    }
  });

  it('authenticates once per Odoo operation and reuses the id within a batch', async () => {
    const stub = await stubServer((recorded) => {
      const body = recorded.body as { params: { method: string; args: unknown[] } };
      if (body.params.method === 'login')
        return { status: 200, body: { jsonrpc: '2.0', result: 7 } };
      if (body.params.method === 'execute_kw') {
        const args = body.params.args as [string, number, string, string, string, unknown[]];
        const method = args[4];
        if (method === 'create') return { status: 200, body: { jsonrpc: '2.0', result: 31 } };
        if (method === 'search_read') {
          return { status: 200, body: { jsonrpc: '2.0', result: [{ id: 31, name: 'INV-1' }] } };
        }
        return { status: 200, body: { jsonrpc: '2.0', result: true } };
      }
      return { status: 200, body: { jsonrpc: '2.0', result: 1 } };
    });

    try {
      const odoo = new OdooConnector();
      const config = {
        baseUrl: stub.baseUrl,
        database: 'acme',
        username: 'integration',
        apiKey: 'key-1',
        model: 'account.move',
      };
      odoo.validateConfig(config);

      const created = await odoo.create(
        [{ values: { name: 'INV-1', amount_total: 99 } }, { values: { name: 'INV-2' } }],
        config,
        { ...context, fetchImpl: stub.fetchImpl },
      );
      expect(created.created).toBe(2);

      const found = await odoo.search({ where: { name: 'INV-1' } }, config, {
        ...context,
        fetchImpl: stub.fetchImpl,
      });
      expect(found[0]!.values).toMatchObject({ id: 31 });

      const updated = await odoo.update(
        [{ values: { id: 31, amount_total: 100 } }, { values: { id: 32, amount_total: 50 } }],
        ['id'],
        config,
        { ...context, fetchImpl: stub.fetchImpl },
      );
      expect(updated.updated).toBe(2);

      // Two batch operations and one search authenticate separately; each batch logs in once.
      const logins = stub.calls.filter(
        (call) => (call.body as { params?: { method?: string } }).params?.method === 'login',
      );
      expect(logins).toHaveLength(3);

      const write = stub.calls.find((call) => {
        const args = (call.body as { params?: { args?: unknown[] } }).params?.args;
        return Array.isArray(args) && (args as unknown[])[4] === 'write';
      });
      expect((write!.body as { params: { args: unknown[] } }).params.args[5]).toEqual([
        [31],
        { id: 31, amount_total: 100 },
      ]);
    } finally {
      await stub.close();
    }
  });

  it('reauthenticates between Odoo operations when the remote user id changes', async () => {
    let remoteUid = 7;
    const stub = await stubServer((recorded) => {
      const body = recorded.body as { params: { method: string; args: unknown[] } };
      if (body.params.method === 'login') return { status: 200, body: { result: remoteUid } };
      if (body.params.args[1] !== remoteUid)
        return { status: 200, body: { error: { message: 'stale user id' } } };
      return { status: 200, body: { result: 0 } };
    });
    try {
      const connector = new OdooConnector();
      const config = {
        baseUrl: stub.baseUrl,
        database: 'acme',
        username: 'integration',
        apiKey: 'synthetic-key',
      };
      const ctx = { ...context, fetchImpl: stub.fetchImpl };
      expect(await connector.healthCheck(config, ctx)).toEqual({ ok: true });
      remoteUid = 8;
      expect(await connector.healthCheck(config, ctx)).toEqual({ ok: true });
      const logins = stub.calls.filter(
        (call) => (call.body as { params: { method: string } }).params.method === 'login',
      );
      expect(logins).toHaveLength(2);
    } finally {
      await stub.close();
    }
  });

  it('checks changed Odoo credentials rather than reusing a previous login', async () => {
    const stub = await stubServer((recorded) => {
      const body = recorded.body as { params: { method: string; args: unknown[] } };
      if (body.params.method === 'login')
        return { status: 200, body: { result: body.params.args[2] === 'valid-key' ? 7 : false } };
      return { status: 200, body: { result: 0 } };
    });
    try {
      const connector = new OdooConnector();
      const config = {
        baseUrl: stub.baseUrl,
        database: 'acme',
        username: 'integration',
        apiKey: 'valid-key',
      };
      const ctx = { ...context, fetchImpl: stub.fetchImpl };
      expect(await connector.healthCheck(config, ctx)).toEqual({ ok: true });
      expect(await connector.healthCheck({ ...config, apiKey: 'invalid-key' }, ctx)).toMatchObject({
        ok: false,
        error: expect.stringContaining('refused the credentials'),
      });
      expect(stub.calls).toHaveLength(3);
    } finally {
      await stub.close();
    }
  });

  it('does not contact Odoo for empty create or update batches', async () => {
    const stub = await stubServer(() => ({ status: 200, body: { result: 7 } }));
    try {
      const connector = new OdooConnector();
      const config = {
        baseUrl: stub.baseUrl,
        database: 'acme',
        username: 'integration',
        apiKey: 'synthetic-key',
      };
      const ctx = { ...context, fetchImpl: stub.fetchImpl };
      expect(await connector.create([], config, ctx)).toMatchObject({ created: 0 });
      expect(await connector.update([], ['id'], config, ctx)).toMatchObject({ updated: 0 });
      expect(stub.calls).toHaveLength(0);
    } finally {
      await stub.close();
    }
  });

  it('refuses plain http and requires a realm id', () => {
    expect(() =>
      new HubSpotConnector().validateConfig({ baseUrl: 'http://crm.example.com', token: 't' }),
    ).toThrow(/https/i);
    expect(() =>
      new QuickBooksConnector().validateConfig({ baseUrl: 'https://qbo.example.com', token: 't' }),
    ).toThrow(/realmId/i);
    expect(() =>
      new OdooConnector().validateConfig({ baseUrl: 'https://erp.example.com', database: 'db' }),
    ).toThrow(/username/i);
  });

  it('registers all three vendors with the full capability set', () => {
    const registry = new ConnectorRegistry();
    for (const type of ['hubspot', 'odoo', 'quickbooks']) {
      const connector = registry.get(type);
      expect(connector.capabilities).toEqual(
        expect.arrayContaining(['create', 'read', 'update', 'search']),
      );
      expect(typeof connector.search).toBe('function');
    }
  });
});
