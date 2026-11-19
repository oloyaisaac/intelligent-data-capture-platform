import { SqliteDatabase } from '../../src/db/sqlite';
import { loadConfig } from '../../src/config';
import { buildServices } from '../../src/services/container';
import { silentLogger } from '../../src/logger';
import { MemoryStorage } from '../../src/storage';
import { ExtractionsRepository } from '../../src/repositories/document-repo';
import type { OcrProvider } from '../../src/ai/providers/types';

// Test-only child: suspend the real worker midway through its extraction publication transaction.
const path = process.argv[2];
if (!path || !process.send) throw new Error('Database path and IPC channel are required');
const db = new SqliteDatabase({ path });
const storage = new MemoryStorage();
const provider: OcrProvider = {
  name: 'synthetic',
  isLocal: true,
  ocr: async () => ({
    text: 'INVOICE\nInvoice No: CRASH-1\nTotal: UGX 100',
    words: [],
    provider: 'synthetic',
    latencyMs: 1,
    costMicros: 0,
  }),
};

ExtractionsRepository.prototype.replaceFields = async () => {
  process.send?.({ type: 'inside-publication' });
  await new Promise<void>(() => undefined);
};

async function run(): Promise<void> {
  await storage.put('synthetic-image', Buffer.from('synthetic'));
  const config = loadConfig({
    NODE_ENV: 'test',
    DB_DRIVER: 'sqlite',
    JWT_SECRET: 'synthetic-test-secret-32-characters-long',
    WORKER_ENABLED: 'false',
  });
  const services = buildServices({ db, config, provider, storage, logger: silentLogger });
  process.send?.({ type: 'ready' });
  process.on('message', (message) => {
    if (message !== 'start') return;
    void services.worker.drain().then(
      () => process.send?.({ type: 'unexpected-completion' }),
      (error: unknown) =>
        process.send?.({
          type: 'error',
          message: error instanceof Error ? error.message : 'unknown',
        }),
    );
  });
}

void run().catch((error: unknown) => {
  process.send?.({ type: 'error', message: error instanceof Error ? error.message : 'unknown' });
});
