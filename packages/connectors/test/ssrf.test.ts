import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { LookupAddress, LookupOptions } from 'node:dns';
import { Agent } from 'undici';
import { validateBaseUrl } from '../src/crm/http';
import { createGuardedLookup, guardedFetch, isPublicAddress } from '../src/crm/safe-http';
import {
  HubSpotConnector,
  OdooConnector,
  QuickBooksConnector,
  GoogleSheetsConnector,
} from '../src';
import type { ConnectorContext } from '../src/contract';

describe('connector outbound HTTP security', () => {
  it.each([
    'http://127.0.0.1:3000',
    'https://localhost',
    'https://a.localhost.',
    'https://127.0.0.1',
    'https://0177.0.0.1',
    'https://0x7f000001',
    'https://2130706433',
    'https://169.254.169.254',
    'https://[::1]',
    'https://[::ffff:127.0.0.1]',
    'https://8.8.8.8',
    'https://internal',
    'https://user:password@example.com',
    'https://example.com/path?query=x',
    'https://example.com/#fragment',
  ])('rejects unsafe base URL %s', (url) => {
    expect(() => validateBaseUrl(url)).toThrow();
  });

  it('accepts an HTTPS DNS hostname with a base path', () => {
    expect(validateBaseUrl('https://crm.example.com/api/')).toBe('https://crm.example.com/api');
  });

  it.each([
    '0.1.2.3',
    '10.1.2.3',
    '100.64.0.1',
    '127.0.0.2',
    '169.254.169.254',
    '172.16.1.2',
    '192.168.1.2',
    '198.18.0.1',
    '192.0.2.1',
    '224.1.2.3',
    '::',
    '::1',
    '::ffff:127.0.0.1',
    '::ffff:8.8.8.8',
    'fc00::1',
    'fe80::1',
    'ff02::1',
    '2001:db8::1',
    '2002:c0a8:101::1',
    '64:ff9b::c0a8:101',
    'not-an-address',
  ])('blocks non-public or special-use DNS answer %s', (address) => {
    expect(isPublicAddress(address)).toBe(false);
  });

  it.each(['8.8.8.8', '1.1.1.1', '2606:4700:4700::1111'])('allows public address %s', (address) => {
    expect(isPublicAddress(address)).toBe(true);
  });

  function runLookup(addresses: LookupAddress[], options: LookupOptions = { all: true }) {
    const guarded = createGuardedLookup((_host, _options, callback) => callback(null, addresses));
    return new Promise<{ address: string | LookupAddress[]; family?: number }>(
      (resolve, reject) => {
        guarded('connector.example', options, (error, address, family) => {
          if (error) reject(error);
          else resolve({ address, family });
        });
      },
    );
  }

  it('rejects mixed public and private answers rather than selecting the public answer', async () => {
    await expect(
      runLookup([
        { address: '8.8.8.8', family: 4 },
        { address: '127.0.0.1', family: 4 },
      ]),
    ).rejects.toThrow(/non-public/);
  });

  it('returns only validated answers directly to the socket in both lookup modes', async () => {
    const answers = [
      { address: '8.8.8.8', family: 4 },
      { address: '2606:4700:4700::1111', family: 6 },
    ];
    expect(await runLookup(answers)).toEqual({ address: answers, family: undefined });
    expect(await runLookup(answers, { family: 6 })).toEqual({
      address: answers[1]!.address,
      family: 6,
    });
    await expect(runLookup([], { all: true })).rejects.toThrow();
  });

  it('rechecks changed DNS answers on each new lookup', async () => {
    let count = 0;
    const guarded = createGuardedLookup((_host, _options, callback) => {
      count += 1;
      callback(null, [{ address: count === 1 ? '8.8.8.8' : '169.254.169.254', family: 4 }]);
    });
    const resolve = () =>
      new Promise<string | LookupAddress[]>((done, reject) => {
        guarded('connector.example', {}, (error, address) =>
          error ? reject(error) : done(address),
        );
      });
    await expect(resolve()).resolves.toBe('8.8.8.8');
    await expect(resolve()).rejects.toThrow(/non-public/);
  });

  it('blocks a rebinding DNS answer in a real socket lookup without reaching a local server', async () => {
    let hits = 0;
    const server = createServer((_req, res) => {
      hits++;
      res.end('should not reach here');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as AddressInfo).port;
    let lookups = 0;
    const agent = new Agent({
      connect: {
        lookup: createGuardedLookup((_host, _options, cb) => {
          lookups++;
          cb(null, [{ address: '127.0.0.1', family: 4 }]);
        }),
      },
    });
    try {
      await expect(
        fetch(`http://connector.example:${port}/`, { dispatcher: agent } as unknown as RequestInit),
      ).rejects.toThrow();
      expect(lookups).toBeGreaterThan(0);
      expect(hits).toBe(0);
    } finally {
      await agent.close();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });

  it('does not follow redirects or send the request body to the redirect target', async () => {
    let targetHits = 0;
    const server = createServer((req, res) => {
      if (req.url === '/target') {
        targetHits++;
        res.end('unexpected');
        return;
      }
      res.writeHead(307, { location: '/target' });
      res.end();
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as AddressInfo).port;
    const context: ConnectorContext = {
      organisationId: 'org',
      logger: { info() {}, warn() {}, debug() {}, error() {} },
      fetchImpl: fetch,
    };
    try {
      await expect(
        guardedFetch(context, `http://127.0.0.1:${port}/redirect`, {
          method: 'POST',
          headers: { authorization: 'Bearer secret' },
          body: 'private data',
        }),
      ).rejects.toThrow();
      expect(targetHits).toBe(0);
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });

  it('uses redirect blocking for all HTTP connector paths', async () => {
    const seen: RequestInit[] = [];
    const fetchImpl: typeof fetch = async (_input, init) => {
      seen.push(init ?? {});
      return new Response(JSON.stringify({ result: 1, results: [], values: [['name']] }), {
        status: 200,
      });
    };
    const context: ConnectorContext = {
      organisationId: 'org',
      logger: { info() {}, warn() {}, debug() {}, error() {} },
      fetchImpl,
    };
    await new HubSpotConnector().healthCheck({ token: 'secret' }, context);
    await new QuickBooksConnector().healthCheck({ token: 'secret', realmId: '1' }, context);
    await new OdooConnector().healthCheck(
      { baseUrl: 'https://odoo.example.com', database: 'db', username: 'u', apiKey: 'secret' },
      context,
    );
    await new GoogleSheetsConnector().describeSchema(
      { spreadsheetId: 'a'.repeat(20), sheetName: 'Sheet1', accessToken: 'secret' },
      context,
    );
    expect(seen.length).toBeGreaterThanOrEqual(5);
    expect(seen.every((init) => init.redirect === 'error')).toBe(true);
  });
});
