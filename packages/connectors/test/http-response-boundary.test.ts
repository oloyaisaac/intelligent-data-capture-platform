import { createServer } from 'node:http';
import { jsonRequest, readHttpConfig, type HttpConfig } from '../src/crm/http';
import type { ConnectorContext } from '../src/contract';

const config: HttpConfig = {
  baseUrl: 'https://vendor.example.com',
  token: 'synthetic-secret',
  object: 'Invoice',
  idField: 'Id',
  timeoutMs: 1000,
};
function context(fetchImpl: typeof fetch): ConnectorContext {
  return {
    organisationId: 'synthetic',
    logger: {
      info: () => undefined,
      warn: () => undefined,
      debug: () => undefined,
      error: () => undefined,
    },
    fetchImpl,
  };
}
function request(fetchImpl: typeof fetch, overrides: Partial<HttpConfig> = {}) {
  return jsonRequest(
    context(fetchImpl),
    { ...config, ...overrides },
    '/query',
    { method: 'GET' },
    'Vendor',
  );
}

it('parses a streamed response below the byte cap and translates bounded errors', async () => {
  const fetchOk: typeof fetch = async () => new Response('{"result":"ok"}', { status: 200 });
  await expect(request(fetchOk)).resolves.toEqual({ status: 200, body: { result: 'ok' } });
  const fetchError: typeof fetch = async () =>
    new Response('{"message":"not found"}', { status: 404 });
  await expect(request(fetchError)).rejects.toMatchObject({ status: 404 });
});

it('aborts and rejects an oversized streaming response without forwarding its content', async () => {
  let cancelled = false;
  let signal: AbortSignal | null | undefined;
  const fetchImpl: typeof fetch = async (_input, init) => {
    signal = init?.signal;
    return new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array(2 * 1024 * 1024));
          controller.enqueue(new TextEncoder().encode('synthetic-body-secret'));
        },
        cancel() {
          cancelled = true;
        },
      }),
      { status: 200 },
    );
  };
  await expect(request(fetchImpl)).rejects.toThrow('response exceeded the size limit');
  expect(signal?.aborted).toBe(true);
  expect(cancelled).toBe(true);
});

it('times out a stalled body even if an injected fetch ignores abort', async () => {
  let cancelled = false;
  const fetchImpl: typeof fetch = async () =>
    new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('{'));
        },
        cancel() {
          cancelled = true;
        },
      }),
      { status: 200 },
    );
  await expect(request(fetchImpl, { timeoutMs: 30 })).rejects.toThrow('request timed out');
  expect(cancelled).toBe(true);
});

it('cancels a late response from a fetch implementation that ignores abort', async () => {
  let cancelled = false;
  const fetchImpl: typeof fetch = async () => {
    await new Promise((resolve) => setTimeout(resolve, 60));
    return new Response(
      new ReadableStream<Uint8Array>({
        cancel() {
          cancelled = true;
        },
      }),
    );
  };
  await expect(request(fetchImpl, { timeoutMs: 10 })).rejects.toThrow('request timed out');
  await new Promise((resolve) => setTimeout(resolve, 100));
  expect(cancelled).toBe(true);
});

it('times out after real HTTP headers arrive but before a body finishes', async () => {
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.write('{');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Invalid test server');
    const fetchImpl: typeof fetch = (_input, init) =>
      fetch(`http://127.0.0.1:${address.port}/`, init);
    await expect(request(fetchImpl, { timeoutMs: 200 })).rejects.toThrow('request timed out');
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

it.each([0, -1, 1.5, Infinity, NaN, 120001, '1000'])(
  'rejects invalid timeout %s',
  async (timeoutMs) => {
    expect(() =>
      readHttpConfig(
        { baseUrl: config.baseUrl, token: config.token, timeoutMs },
        { baseUrl: config.baseUrl, object: 'Invoice' },
      ),
    ).toThrow('timeoutMs');
  },
);
