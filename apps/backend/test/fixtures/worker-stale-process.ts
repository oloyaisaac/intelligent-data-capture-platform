import { SqliteDatabase } from '../../src/db/sqlite';
import { loadConfig } from '../../src/config';
import { buildServices } from '../../src/services/container';
import { silentLogger } from '../../src/logger';
import { MemoryStorage } from '../../src/storage';
import type { OcrProvider } from '../../src/ai/providers/types';

const path = process.argv[2];
const mode = process.argv[3];
if (!path || !process.send || (mode !== 'hold' && mode !== 'recover')) {
  throw new Error('Database path, mode and IPC channel are required');
}
const db = new SqliteDatabase({ path });
const storage = new MemoryStorage();
let resumeOcr: (() => void) | undefined;
const provider: OcrProvider = {
  name: 'synthetic',
  isLocal: true,
  ocr: async () => {
    process.send?.({ type: 'ocr-entered' });
    if (mode === 'hold')
      await new Promise<void>((resolve) => {
        resumeOcr = resolve;
      });
    return {
      text: 'INVOICE\nInvoice No: STALE-1\nTotal: UGX 100',
      words: [],
      provider: 'synthetic',
      latencyMs: 1,
      costMicros: 0,
    };
  },
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
  process.on('message', (message) => {
    if (message === 'resume') {
      resumeOcr?.();
      return;
    }
    if (message === 'quit') {
      void db.close().then(() => process.disconnect?.());
      return;
    }
    if (message !== 'start') return;
    void (async () => {
      if (mode === 'recover') {
        await services.worker.start();
        await services.worker.stop();
      }
      await services.worker.drain();
      process.send?.({ type: 'finished' });
    })().catch((error: unknown) =>
      process.send?.({
        type: 'error',
        message: error instanceof Error ? error.message : 'unknown',
      }),
    );
  });
  process.send?.({ type: 'ready' });
}
void run().catch((error: unknown) =>
  process.send?.({ type: 'error', message: error instanceof Error ? error.message : 'unknown' }),
);
