import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
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

describe('connectors (CON-001, CON-003, MAP-001, DUP-001)', () => {
  let harness: Harness;
  let directory: string;

  beforeAll(async () => {
    harness = await createHarness();
    directory = await mkdtemp(join(tmpdir(), 'idcp-connector-'));
  });

  afterAll(async () => {
    await harness.close();
  });

  async function approvedDocument(account: TestAccount): Promise<string> {
    harness.ocr.setText(SAMPLE_INVOICE_TEXT);
    const upload = await uploadDocument(harness, account, {
      content: fakePng(`conn-${Math.random()}`),
    });
    const documentId = upload.json<{ id: string }>().id;
    await drainWorker(harness);
    await approveDocument(harness, account, documentId);
    return documentId;
  }

  async function createCsvConnector(account: TestAccount, filename: string): Promise<string> {
    const response = await harness.api.json('POST', '/api/v1/connectors', {
      token: account.accessToken,
      body: { type: 'csv', name: 'CSV sink', config: { directory, filename } },
    });
    expect(response.statusCode).toBe(201);
    return response.json<{ id: string }>().id;
  }

  async function createMapping(account: TestAccount, connectorId: string, keys: string[] = []) {
    const response = await harness.api.json('POST', '/api/v1/mapping-profiles', {
      token: account.accessToken,
      body: {
        connectorId,
        documentType: 'invoice',
        name: 'Invoice to CSV',
        fieldMap: [
          { udmPath: 'invoice.number', destinationField: 'InvoiceNumber', transform: 'trim' },
          { udmPath: 'total.amount', destinationField: 'Total', transform: 'number' },
          { udmPath: 'document.date', destinationField: 'Date', transform: 'date_iso' },
        ],
        duplicatePolicy: keys.length > 0 ? 'skip' : 'append',
        duplicateKeys: keys,
      },
    });
    expect(response.statusCode).toBe(201);
    return response.json<{ id: string }>().id;
  }

  it('lists the available connector types', async () => {
    const account = await registerAccount(harness);
    const response = await harness.api.get('/api/v1/connectors/types', account.accessToken);
    const types = response
      .json<{ items: Array<{ type: string }> }>()
      .items.map((item) => item.type);
    expect(types).toEqual(expect.arrayContaining(['csv', 'sqlite', 'postgres', 'google_sheets']));
  });

  it('validates connector configuration before saving it', async () => {
    const account = await registerAccount(harness);
    const response = await harness.api.json('POST', '/api/v1/connectors', {
      token: account.accessToken,
      body: { type: 'csv', name: 'Broken', config: { directory, filename: '../escape.csv' } },
    });
    expect(response.statusCode).toBe(400);
  });

  it('rejects internal HTTP connector endpoints and revalidates credential overrides at execution', async () => {
    const account = await registerAccount(harness);
    const bad = await harness.api.json('POST', '/api/v1/connectors', {
      token: account.accessToken,
      body: {
        type: 'hubspot',
        name: 'Internal',
        config: { baseUrl: 'http://127.0.0.1:1234', token: 'x' },
      },
    });
    expect(bad.statusCode).toBe(400);

    // Encrypted credentials are merged after configuration validation, so a malicious override must
    // still be rejected at execution, before any outbound request is made.
    const created = await harness.api.json('POST', '/api/v1/connectors', {
      token: account.accessToken,
      body: {
        type: 'hubspot',
        name: 'Override',
        config: { baseUrl: 'https://api.hubapi.com', token: 'x' },
        credentials: { baseUrl: 'https://127.0.0.1' },
      },
    });
    expect(created.statusCode).toBe(201);
    const fetchSpy = jest.spyOn(globalThis, 'fetch');
    try {
      const tested = await harness.api.json(
        'POST',
        `/api/v1/connectors/${created.json<{ id: string }>().id}/test`,
        {
          token: account.accessToken,
        },
      );
      expect(tested.statusCode).toBe(200);
      expect(tested.json()).toMatchObject({ ok: false });
      // The test harness uses fetch to call the local API; ensure none targeted the malicious URL.
      expect(fetchSpy.mock.calls.every(([url]) => !String(url).includes('https://127.0.0.1'))).toBe(
        true,
      );
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('writes an approved record to a CSV destination end to end', async () => {
    const account = await registerAccount(harness);
    const connectorId = await createCsvConnector(account, 'invoices.csv');
    const mappingId = await createMapping(account, connectorId);
    const documentId = await approvedDocument(account);

    const send = await harness.api.json('POST', `/api/v1/documents/${documentId}/send`, {
      token: account.accessToken,
      body: { connectorId, mappingProfileId: mappingId },
    });
    expect(send.statusCode).toBe(202);
    const result = send.json<{ status: string; created: number }>();
    expect(result.status).toBe('succeeded');
    expect(result.created).toBe(1);

    const content = await readFile(join(directory, 'invoices.csv'), 'utf8');
    const rows = parseCsv(content);
    expect(rows[0]).toEqual(['InvoiceNumber', 'Total', 'Date']);
    expect(rows[1]).toEqual(['INV-1042', '1121000', '2026-10-26']);

    const run = await harness.db.one<{ status: string }>(
      'SELECT status FROM connector_runs WHERE document_id = ?',
      [documentId],
    );
    expect(run?.status).toBe('succeeded');
  });

  it('refuses to send a record that is not approved', async () => {
    const account = await registerAccount(harness);
    const connectorId = await createCsvConnector(account, 'unapproved.csv');
    const mappingId = await createMapping(account, connectorId);

    harness.ocr.setText(SAMPLE_INVOICE_TEXT);
    const upload = await uploadDocument(harness, account, {
      content: fakePng('not approved send'),
    });
    const documentId = upload.json<{ id: string }>().id;
    await drainWorker(harness);

    const send = await harness.api.json('POST', `/api/v1/documents/${documentId}/send`, {
      token: account.accessToken,
      body: { connectorId, mappingProfileId: mappingId },
    });
    expect(send.statusCode).toBe(409);
  });

  it('skips a duplicate instead of writing it twice (DUP-001)', async () => {
    const account = await registerAccount(harness);
    const connectorId = await createCsvConnector(account, 'dedupe.csv');
    const mappingId = await createMapping(account, connectorId, ['InvoiceNumber']);
    const documentId = await approvedDocument(account);

    const first = await harness.api.json('POST', `/api/v1/documents/${documentId}/send`, {
      token: account.accessToken,
      body: { connectorId, mappingProfileId: mappingId },
    });
    expect(first.json<{ status: string }>().status).toBe('succeeded');

    const second = await harness.api.json('POST', `/api/v1/documents/${documentId}/send`, {
      token: account.accessToken,
      body: { connectorId, mappingProfileId: mappingId },
    });
    expect(second.statusCode).toBe(202);
    expect(second.json<{ status: string }>().status).toBe('skipped_duplicate');

    const content = await readFile(join(directory, 'dedupe.csv'), 'utf8');
    const rows = parseCsv(content);
    expect(rows.filter((row) => row[0] === 'INV-1042')).toHaveLength(1);
  });

  it('inserts into a SQLite destination inside a transaction (CON-003)', async () => {
    const account = await registerAccount(harness);
    const dbPath = join(directory, 'destination.sqlite');

    const destination = new DatabaseSync(dbPath);
    destination.exec('CREATE TABLE invoices (invoice_number TEXT, total REAL, invoice_date TEXT)');
    destination.close();

    const connector = await harness.api.json('POST', '/api/v1/connectors', {
      token: account.accessToken,
      body: { type: 'sqlite', name: 'SQLite sink', config: { path: dbPath, table: 'invoices' } },
    });
    expect(connector.statusCode).toBe(201);
    const connectorId = connector.json<{ id: string }>().id;

    const schema = await harness.api.get(
      `/api/v1/connectors/${connectorId}/schema`,
      account.accessToken,
    );
    expect(schema.statusCode).toBe(200);
    expect(
      schema.json<{ fields: Array<{ key: string }> }>().fields.map((field) => field.key),
    ).toEqual(['invoice_number', 'total', 'invoice_date']);

    const mapping = await harness.api.json('POST', '/api/v1/mapping-profiles', {
      token: account.accessToken,
      body: {
        connectorId,
        documentType: 'invoice',
        name: 'Invoice to SQLite',
        fieldMap: [
          { udmPath: 'invoice.number', destinationField: 'invoice_number', transform: 'none' },
          { udmPath: 'total.amount', destinationField: 'total', transform: 'number' },
          { udmPath: 'document.date', destinationField: 'invoice_date', transform: 'date_iso' },
        ],
        duplicatePolicy: 'append',
        duplicateKeys: [],
      },
    });
    const mappingId = mapping.json<{ id: string }>().id;

    const documentId = await approvedDocument(account);
    const send = await harness.api.json('POST', `/api/v1/documents/${documentId}/send`, {
      token: account.accessToken,
      body: { connectorId, mappingProfileId: mappingId },
    });
    expect(send.statusCode).toBe(202);
    expect(send.json<{ status: string }>().status).toBe('succeeded');

    const check = new DatabaseSync(dbPath);
    const rows = check
      .prepare('SELECT invoice_number, total, invoice_date FROM invoices')
      .all() as Array<Record<string, unknown>>;
    check.close();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      invoice_number: 'INV-1042',
      total: 1121000,
      invoice_date: '2026-10-26',
    });
  });

  it('encrypts connector credentials at rest', async () => {
    const account = await registerAccount(harness);
    const response = await harness.api.json('POST', '/api/v1/connectors', {
      token: account.accessToken,
      body: {
        type: 'postgres',
        name: 'Warehouse',
        config: { connectionString: 'postgres://user@localhost:5432/db', table: 'invoices' },
        credentials: { password: 'super-secret-password' },
      },
    });
    expect(response.statusCode).toBe(201);
    const connectorId = response.json<{ id: string }>().id;

    const row = await harness.db.one<{ credentials_encrypted: string }>(
      'SELECT credentials_encrypted FROM connectors WHERE id = ?',
      [connectorId],
    );
    expect(row?.credentials_encrypted).toBeTruthy();
    expect(row?.credentials_encrypted).not.toContain('super-secret-password');

    // The API never returns credentials back to a client.
    const list = await harness.api.get('/api/v1/connectors', account.accessToken);
    expect(list.body).not.toContain('super-secret-password');
    expect(list.body).not.toContain('credentials');
  });

  it('requires an admin role to create a connector (AUTH-002)', async () => {
    const account = await registerAccount(harness);
    await harness.db.execute("UPDATE memberships SET role = 'viewer' WHERE user_id = ?", [
      account.userId,
    ]);

    const response = await harness.api.json('POST', '/api/v1/connectors', {
      token: account.accessToken,
      body: { type: 'csv', name: 'Nope', config: { directory, filename: 'nope.csv' } },
    });
    expect(response.statusCode).toBe(403);
    expect(response.json<{ error: { code: string } }>().error.code).toBe('ROLE_REQUIRED');

    await harness.db.execute("UPDATE memberships SET role = 'owner' WHERE user_id = ?", [
      account.userId,
    ]);
  });

  it('reports an actionable error when a destination is unreachable', async () => {
    const account = await registerAccount(harness);
    const response = await harness.api.json('POST', '/api/v1/connectors', {
      token: account.accessToken,
      body: {
        type: 'postgres',
        name: 'Unreachable',
        config: {
          connectionString: 'postgres://nobody@127.0.0.1:1/nothing?connect_timeout=1',
          table: 'invoices',
        },
      },
    });
    const connectorId = response.json<{ id: string }>().id;

    const tested = await harness.api.json('POST', `/api/v1/connectors/${connectorId}/test`, {
      token: account.accessToken,
    });
    expect(tested.statusCode).toBe(200);
    expect(tested.json<{ ok: boolean }>().ok).toBe(false);

    const row = await harness.db.one<{ status: string; last_error: string }>(
      'SELECT status, last_error FROM connectors WHERE id = ?',
      [connectorId],
    );
    expect(row?.status).toBe('error');
    expect(row?.last_error).toBeTruthy();
  });

  it('previews a duplicate with its score and matched fields before writing (DUP-001)', async () => {
    const account = await registerAccount(harness);
    const dbPath = join(directory, 'preview.sqlite');

    const destination = new DatabaseSync(dbPath);
    destination.exec(
      'CREATE TABLE invoices (invoice_number TEXT, total REAL, invoice_date TEXT, note TEXT)',
    );
    destination
      .prepare('INSERT INTO invoices VALUES (?, ?, ?, ?)')
      .run('INV-1042', 1121000, '2026-10-26', 'existing row');
    destination.close();

    const connector = await harness.api.json('POST', '/api/v1/connectors', {
      token: account.accessToken,
      body: { type: 'sqlite', name: 'SQLite sink', config: { path: dbPath, table: 'invoices' } },
    });
    const connectorId = connector.json<{ id: string }>().id;

    const mapping = await harness.api.json('POST', '/api/v1/mapping-profiles', {
      token: account.accessToken,
      body: {
        connectorId,
        documentType: 'invoice',
        name: 'Invoice to SQLite',
        fieldMap: [
          { udmPath: 'invoice.number', destinationField: 'invoice_number', transform: 'none' },
          { udmPath: 'total.amount', destinationField: 'total', transform: 'number' },
        ],
        duplicatePolicy: 'skip',
        duplicateKeys: ['invoice_number'],
      },
    });
    const mappingId = mapping.json<{ id: string }>().id;
    const documentId = await approvedDocument(account);

    const preview = await harness.api.json(
      'GET',
      `/api/v1/documents/${documentId}/duplicates?connectorId=${connectorId}&mappingProfileId=${mappingId}`,
      { token: account.accessToken },
    );
    expect(preview.statusCode).toBe(200);
    const result = preview.json<{
      isDuplicate: boolean;
      bestScore: number;
      matchedKeys: string[];
      threshold: number;
      candidates: Array<{ score: number; matchedKeys: string[]; values: Record<string, unknown> }>;
    }>();
    expect(result.isDuplicate).toBe(true);
    expect(result.bestScore).toBe(1);
    expect(result.matchedKeys).toEqual(['invoice_number']);
    expect(result.candidates[0]?.values.note).toBe('existing row');

    // The preview must not have changed anything.
    const check = new DatabaseSync(dbPath);
    const count = check.prepare('SELECT COUNT(*) AS n FROM invoices').get() as { n: number };
    expect(count.n).toBe(1);
    check.close();
  });

  it('updates the existing row when the policy says update (DUP-001)', async () => {
    const account = await registerAccount(harness);
    const dbPath = join(directory, 'update.sqlite');

    const destination = new DatabaseSync(dbPath);
    destination.exec('CREATE TABLE invoices (invoice_number TEXT, total REAL, note TEXT)');
    destination.prepare('INSERT INTO invoices VALUES (?, ?, ?)').run('INV-1042', 1, 'old total');
    destination.close();

    const connector = await harness.api.json('POST', '/api/v1/connectors', {
      token: account.accessToken,
      body: { type: 'sqlite', name: 'SQLite sink', config: { path: dbPath, table: 'invoices' } },
    });
    const connectorId = connector.json<{ id: string }>().id;

    const mapping = await harness.api.json('POST', '/api/v1/mapping-profiles', {
      token: account.accessToken,
      body: {
        connectorId,
        documentType: 'invoice',
        name: 'Invoice update',
        fieldMap: [
          { udmPath: 'invoice.number', destinationField: 'invoice_number', transform: 'none' },
          { udmPath: 'total.amount', destinationField: 'total', transform: 'number' },
        ],
        duplicatePolicy: 'update',
        duplicateKeys: ['invoice_number'],
      },
    });
    const mappingId = mapping.json<{ id: string }>().id;
    const documentId = await approvedDocument(account);

    const send = await harness.api.json('POST', `/api/v1/documents/${documentId}/send`, {
      token: account.accessToken,
      body: { connectorId, mappingProfileId: mappingId },
    });
    expect(send.statusCode).toBe(202);
    expect(send.json<{ status: string; updated: number }>().status).toBe('succeeded');
    expect(send.json<{ updated: number }>().updated).toBe(1);

    const check = new DatabaseSync(dbPath);
    const row = check.prepare('SELECT total, note FROM invoices').get() as {
      total: number;
      note: string;
    };
    expect(row.total).toBe(1121000);
    // A merge/update never invents values for columns the mapping does not cover.
    expect(row.note).toBe('old total');
    check.close();
  });

  it('merges into the existing row and never overwrites a reviewed value (DUP-001)', async () => {
    const account = await registerAccount(harness);
    const dbPath = join(directory, 'merge.sqlite');

    const destination = new DatabaseSync(dbPath);
    destination.exec('CREATE TABLE invoices (invoice_number TEXT, total REAL, note TEXT)');
    destination
      .prepare('INSERT INTO invoices VALUES (?, ?, ?)')
      .run('INV-1042', 1, 'confidential note');
    destination.close();

    const connector = await harness.api.json('POST', '/api/v1/connectors', {
      token: account.accessToken,
      body: { type: 'sqlite', name: 'SQLite sink', config: { path: dbPath, table: 'invoices' } },
    });
    const connectorId = connector.json<{ id: string }>().id;

    const mapping = await harness.api.json('POST', '/api/v1/mapping-profiles', {
      token: account.accessToken,
      body: {
        connectorId,
        documentType: 'invoice',
        name: 'Invoice merge',
        fieldMap: [
          { udmPath: 'invoice.number', destinationField: 'invoice_number', transform: 'none' },
          { udmPath: 'total.amount', destinationField: 'total', transform: 'number' },
        ],
        duplicatePolicy: 'merge',
        duplicateKeys: ['invoice_number'],
      },
    });
    const mappingId = mapping.json<{ id: string }>().id;
    const documentId = await approvedDocument(account);

    const send = await harness.api.json('POST', `/api/v1/documents/${documentId}/send`, {
      token: account.accessToken,
      body: { connectorId, mappingProfileId: mappingId },
    });
    expect(send.statusCode).toBe(202);
    expect(send.json<{ status: string }>().status).toBe('succeeded');

    const check = new DatabaseSync(dbPath);
    const rows = check.prepare('SELECT invoice_number, total, note FROM invoices').all() as Array<{
      invoice_number: string;
      total: number;
      note: string;
    }>;
    // One row, merged — not a second insert.
    expect(rows).toHaveLength(1);
    expect(rows[0]?.total).toBe(1121000);
    expect(rows[0]?.note).toBe('confidential note');
    check.close();
  });
});
