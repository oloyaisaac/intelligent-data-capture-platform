import { createServer, type Server } from 'node:http';
import { CloudVisionProvider } from '../src/ai/providers/cloud';
import { silentLogger } from '../src/logger';

async function listen(server: Server): Promise<number> {
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  return (server.address() as { port: number }).port;
}
async function close(server: Server): Promise<void> {
  await new Promise<void>((done, reject) =>
    server.close((error) => (error ? reject(error) : done())),
  );
}

it.each([301, 302, 303, 307, 308])(
  'does not forward document bytes on HTTP %s redirects',
  async (status) => {
    let forwarded = 0;
    const target = createServer((request, response) => {
      forwarded++;
      request.resume();
      response.end('{}');
    });
    const port = await listen(target);
    const source = createServer((request, response) => {
      request.resume();
      response.writeHead(status, { location: `http://127.0.0.1:${port}/target` });
      response.end();
    });
    const sourcePort = await listen(source);
    try {
      const provider = new CloudVisionProvider({
        endpoint: `http://127.0.0.1:${sourcePort}/source`,
        apiKey: 'synthetic-secret',
        model: 'fake',
        maxCostMicrosPerDocument: 5,
      });
      await expect(
        provider.ocr(
          { buffer: Buffer.from('synthetic document'), mimeType: 'image/png' },
          { logger: silentLogger },
        ),
      ).rejects.toThrow('Could not reach or read the cloud AI provider response.');
      expect(forwarded).toBe(0);
    } finally {
      await close(source);
      await close(target);
    }
  },
);
