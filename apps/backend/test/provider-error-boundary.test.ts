import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { CloudVisionProvider } from '../src/ai/providers/cloud';
import { TesseractProvider } from '../src/ai/providers/tesseract';
import { ProviderUnavailableError } from '../src/ai/providers/types';
import { createLogger } from '../src/logger';

const secret = 'SYNTHETIC-CREDENTIAL-AND-DOCUMENT-CONTENT';
const logger = createLogger({ level: 'debug', sink: () => undefined });
const input = { buffer: Buffer.from('synthetic document'), mimeType: 'image/png' };
const cloud = (fetchImpl: typeof fetch) =>
  new CloudVisionProvider({
    endpoint: 'https://example.com/ocr',
    apiKey: secret,
    model: 'synthetic',
    maxCostMicrosPerDocument: 10,
    fetchImpl,
  });

it.each([new Error(secret), new ProviderUnavailableError(secret), { message: secret }, null])(
  'does not propagate arbitrary cloud transport failures',
  async (error) => {
    const fetchImpl = jest.fn().mockRejectedValue(error) as unknown as typeof fetch;
    await expect(cloud(fetchImpl).ocr(input, { logger })).rejects.toThrow(
      'Could not reach or read the cloud AI provider response.',
    );
    try {
      await cloud(fetchImpl).ocr(input, { logger });
    } catch (failure) {
      expect(String(failure)).not.toContain(secret);
    }
  },
);

it('does not leak parsing failures and preserves safe provider status and timeout messages', async () => {
  const parsing = jest.fn().mockResolvedValue({
    ok: true,
    json: async () => {
      throw new ProviderUnavailableError(secret);
    },
  }) as unknown as typeof fetch;
  await expect(cloud(parsing).ocr(input, { logger })).rejects.toThrow(
    'Could not reach or read the cloud AI provider response.',
  );
  for (const [status, expected] of [
    [401, 'rejected our credentials'],
    [429, 'rate limiting'],
    [503, 'HTTP 503'],
  ] as const) {
    const failed = jest.fn().mockResolvedValue({ ok: false, status }) as unknown as typeof fetch;
    await expect(cloud(failed).ocr(input, { logger })).rejects.toThrow(expected);
  }
  const abort = Object.assign(new Error(secret), { name: 'AbortError' });
  const timedOut = jest.fn().mockRejectedValue(abort) as unknown as typeof fetch;
  await expect(cloud(timedOut).ocr(input, { logger })).rejects.toThrow('timed out');
});

it('reports a missing local engine without revealing its path', async () => {
  const binary = join(tmpdir(), `missing-${secret}`, 'tesseract');
  try {
    await new TesseractProvider(binary).ocr(input, { logger });
    throw new Error('Expected missing engine to fail');
  } catch (error) {
    expect(String(error)).toContain('Local OCR engine is not installed');
    expect(String(error)).not.toContain(secret);
  }
});

it('does not expose local OCR stderr or temporary path on child failure', async () => {
  if (process.platform === 'win32') return;
  const directory = await mkdtemp(join(tmpdir(), 'idcp-provider-test-'));
  try {
    const binary = join(directory, 'ocr');
    await writeFile(binary, `#!/bin/sh\necho '${secret}' >&2\nexit 1\n`);
    await chmod(binary, 0o700);
    const operation = () => new TesseractProvider(binary).ocr(input, { logger });
    await expect(operation()).rejects.toThrow('Local OCR failed. Check the engine and try again.');
    try {
      await operation();
    } catch (error) {
      expect(String(error)).not.toContain(secret);
      expect(String(error)).not.toContain(directory);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
