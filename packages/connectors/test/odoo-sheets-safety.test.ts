import { GoogleSheetsConnector } from '../src/google-sheets-connector';
import { OdooConnector } from '../src/crm/odoo-connector';
import type { ConnectorContext } from '../src/contract';

const sheets = {
  spreadsheetId: 'a'.repeat(25),
  sheetName: 'Invoices',
  accessToken: 'synthetic',
  timeoutMs: 40,
};
const odoo = {
  baseUrl: 'https://odoo.example.com',
  database: 'test',
  username: 'test',
  apiKey: 'synthetic',
  timeoutMs: 40,
};
function context(fetchImpl: typeof fetch): ConnectorContext {
  return {
    organisationId: 'synthetic',
    logger: { info() {}, warn() {}, debug() {}, error() {} },
    fetchImpl,
  };
}
function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status });
}
function stalled(): Response {
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{'));
      },
    }),
    { status: 200 },
  );
}
function oversized(): Response {
  return new Response(new Uint8Array(2 * 1024 * 1024 + 1));
}

it.each([stalled, oversized])(
  'rejects stalled or oversized Sheets responses before writing',
  async (body) => {
    const calls: string[] = [];
    const fetchImpl: typeof fetch = async (_url, init) => {
      calls.push(init?.method ?? 'GET');
      return body();
    };
    await expect(
      new GoogleSheetsConnector().create([{ values: { id: '1' } }], sheets, context(fetchImpl)),
    ).rejects.toThrow();
    expect(calls).toEqual(['GET']);
  },
);

it('does not overwrite a header after failed, malformed, or duplicate-header responses', async () => {
  for (const response of [
    json({ error: 'synthetic' }, 503),
    json({}),
    json({ values: [['id', 'id']] }),
    json({ values: [null] }),
  ]) {
    const calls: string[] = [];
    const fetchImpl: typeof fetch = async (_url, init) => {
      calls.push(init?.method ?? 'GET');
      return response;
    };
    await expect(
      new GoogleSheetsConnector().create([{ values: { id: '1' } }], sheets, context(fetchImpl)),
    ).rejects.toThrow();
    expect(calls).toEqual(['GET']);
  }
});

it('validates every incoming column before initializing a blank sheet', async () => {
  const calls: string[] = [];
  const fetchImpl: typeof fetch = async (_url, init) => {
    calls.push(init?.method ?? 'GET');
    return json({ range: 'Invoices!1:1' });
  };
  await expect(
    new GoogleSheetsConnector().create(
      [{ values: { id: '1' } }, { values: { id: '2', hidden: 'x' } }],
      sheets,
      context(fetchImpl),
    ),
  ).rejects.toThrow('missing these columns');
  expect(calls).toEqual(['GET']);
});

it('uses RAW for header and data and passes formula-looking content as data', async () => {
  const calls: Array<{ url: string; method: string; body: string }> = [];
  const fetchImpl: typeof fetch = async (url, init) => {
    calls.push({ url: String(url), method: init?.method ?? 'GET', body: String(init?.body ?? '') });
    return calls.length === 1 ? json({ range: 'Invoices!1:1' }) : json({});
  };
  await expect(
    new GoogleSheetsConnector().create(
      [{ values: { id: '=SUM(1,2)' } }],
      sheets,
      context(fetchImpl),
    ),
  ).resolves.toMatchObject({ created: 1 });
  expect(calls.map((call) => call.method)).toEqual(['GET', 'PUT', 'POST']);
  expect(calls[1]!.url).toContain('valueInputOption=RAW');
  expect(calls[2]!.url).toContain('valueInputOption=RAW');
  expect(JSON.parse(calls[2]!.body)).toEqual({ values: [['=SUM(1,2)']] });
});

it('does not treat malformed Sheets data as an empty duplicate lookup', async () => {
  for (const response of [json({}), json({ values: [null] }), json({ values: [['id'], 'bad'] })]) {
    await expect(
      new GoogleSheetsConnector().read(
        {},
        sheets,
        context(async () => response),
      ),
    ).rejects.toThrow();
  }
  await expect(
    new GoogleSheetsConnector().read(
      {},
      sheets,
      context(async () => json({ range: 'Invoices!A1:Z10' })),
    ),
  ).resolves.toEqual([]);
});

it.each([stalled, oversized])(
  'bounds Odoo authentication and subsequent response bodies',
  async (body) => {
    for (const stalledAt of [1, 2]) {
      let calls = 0;
      const fetchImpl: typeof fetch = async () => {
        calls++;
        return calls === stalledAt ? body() : json({ result: 1 });
      };
      await expect(new OdooConnector().read({}, odoo, context(fetchImpl))).rejects.toThrow();
      expect(calls).toBe(stalledAt);
    }
  },
);

it('rejects missing or invalid Odoo lookup results rather than returning no matches', async () => {
  for (const result of [{}, { result: null }, { result: false }, { result: [null] }]) {
    let count = 0;
    const fetchImpl: typeof fetch = async () => json(++count === 1 ? { result: 1 } : result);
    await expect(
      new OdooConnector().search({ where: { name: 'invoice' } }, odoo, context(fetchImpl)),
    ).rejects.toThrow();
  }
});

it('requires valid Odoo record IDs and explicit write success', async () => {
  let count = 0;
  const fetchImpl: typeof fetch = async () =>
    json(++count === 1 ? { result: 1 } : { result: false });
  const connector = new OdooConnector();
  await expect(
    connector.update(
      [{ values: { id: 'not-an-id', name: 'x' } }],
      ['id'],
      odoo,
      context(fetchImpl),
    ),
  ).rejects.toThrow('positive integer');
  expect(count).toBe(0);
  await expect(
    connector.update([{ values: { id: 12, name: 'x' } }], ['id'], odoo, context(fetchImpl)),
  ).rejects.toThrow('did not confirm');
  expect(count).toBe(2);
});

it.each(['PUT', 'POST'])(
  'bounds the Google Sheets %s response after a remote write',
  async (stalledMethod) => {
    const calls: string[] = [];
    const fetchImpl: typeof fetch = async (_url, init) => {
      const method = init?.method ?? 'GET';
      calls.push(method);
      if (method === stalledMethod) return stalled();
      return method === 'GET' ? json({ range: 'Invoices!1:1' }) : json({});
    };
    await expect(
      new GoogleSheetsConnector().create([{ values: { id: '1' } }], sheets, context(fetchImpl)),
    ).rejects.toThrow();
    expect(calls).toContain(stalledMethod);
  },
);

it('validates Odoo limits and model on every operation before making network calls', async () => {
  const fetchImpl = jest.fn() as jest.MockedFunction<typeof fetch>;
  const connector = new OdooConnector();
  const ctx = context(fetchImpl);
  await expect(connector.read({ limit: -1 }, odoo, ctx)).rejects.toThrow('positive integer');
  await expect(connector.search({}, { ...odoo, model: 'account.move/other' }, ctx)).rejects.toThrow(
    'model',
  );
  expect(fetchImpl).not.toHaveBeenCalled();
});
