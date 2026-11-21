import { QuickBooksConnector } from '../src/crm/quickbooks-connector';
import type { ConnectorContext } from '../src/contract';

const config = {
  baseUrl: 'https://qbo.example.com',
  token: 'synthetic',
  realmId: '123',
  object: 'Invoice',
};

function setup() {
  const calls: string[] = [];
  const fetchImpl: typeof fetch = async (input) => {
    calls.push(String(input));
    return new Response(JSON.stringify({ QueryResponse: { Invoice: [] } }), { status: 200 });
  };
  const context: ConnectorContext = {
    organisationId: 'synthetic',
    logger: {
      info: () => undefined,
      warn: () => undefined,
      debug: () => undefined,
      error: () => undefined,
    },
    fetchImpl,
  };
  const connector = new QuickBooksConnector();
  const query = (index: number) => new URL(calls[index]!).searchParams.get('query');
  return { calls, context, connector, query };
}

it('constructs bounded queries with validated identifiers and escaped apostrophes', async () => {
  const { connector, context, query } = setup();
  await connector.search(
    {
      where: {
        DocNumber: "INV O'Brien & sons",
        'MetaData.LastUpdatedTime': '2026-01-01',
        Active: true,
        Amount: 42,
      },
      limit: 500,
    },
    config,
    context,
  );
  expect(query(0)).toBe(
    "select * from Invoice where DocNumber = 'INV O\\'Brien & sons' and MetaData.LastUpdatedTime = '2026-01-01' and Active = true and Amount = 42 maxresults 100",
  );
  await connector.read({}, config, context);
  expect(query(1)).toBe('select * from Invoice maxresults 100');
  await connector.describeSchema(config, context);
  expect(query(2)).toBe('select * from Invoice maxresults 1');
});

it.each([
  'DocNumber OR Id',
  'DocNumber=1',
  "DocNumber'",
  'DocNumber--',
  'MetaData..LastUpdatedTime',
  '__proto__',
])('rejects unsafe field %s before the request', async (field) => {
  const { connector, context, calls } = setup();
  await expect(connector.search({ where: { [field]: 'value' } }, config, context)).rejects.toThrow(
    'filter field',
  );
  expect(calls).toEqual([]);
});

it.each(["x\\' OR Id = '1", 'newline\nvalue', 'null\0value'])(
  'fails closed on ambiguous filter value %j',
  async (value) => {
    const { connector, context, calls } = setup();
    await expect(
      connector.search({ where: { DocNumber: value } }, config, context),
    ).rejects.toThrow('unsupported characters');
    expect(calls).toEqual([]);
  },
);

it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
  'rejects invalid query limit %s',
  async (limit) => {
    const { connector, context, calls } = setup();
    await expect(connector.read({ limit }, config, context)).rejects.toThrow('positive integer');
    expect(calls).toEqual([]);
  },
);

it('validates entity identifiers on each operation even without validateConfig', async () => {
  const { connector, context, calls } = setup();
  const invalid = { ...config, object: 'Invoice where Id=1' };
  await expect(connector.describeSchema(invalid, context)).rejects.toThrow('entity name');
  await expect(connector.read({}, invalid, context)).rejects.toThrow('entity name');
  await expect(connector.search({ where: { Id: '1' } }, invalid, context)).rejects.toThrow(
    'entity name',
  );
  await expect(connector.create([{ values: { Id: '1' } }], invalid, context)).rejects.toThrow(
    'entity name',
  );
  await expect(
    connector.update([{ values: { Id: '1' } }], ['Id'], invalid, context),
  ).rejects.toThrow('entity name');
  await expect(connector.healthCheck(invalid, context)).resolves.toMatchObject({ ok: false });
  expect(calls).toEqual([]);
});

it('rejects non-finite numeric filters before the request', async () => {
  const { connector, context, calls } = setup();
  await expect(connector.search({ where: { Amount: Infinity } }, config, context)).rejects.toThrow(
    'finite',
  );
  expect(calls).toEqual([]);
});
