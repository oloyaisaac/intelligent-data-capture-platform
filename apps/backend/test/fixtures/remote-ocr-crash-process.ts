import { SqliteDatabase } from '../../src/db/sqlite';
import { loadConfig } from '../../src/config';
import { buildServices } from '../../src/services/container';
import { silentLogger } from '../../src/logger';
import { MemoryStorage } from '../../src/storage';
import type { OcrProvider } from '../../src/ai/providers/types';

const path = process.argv[2];
if (!path || !process.send) throw new Error('Database path and IPC channel are required');
const db = new SqliteDatabase({ path });
const storage = new MemoryStorage();
const provider: OcrProvider = {
  name: 'synthetic-remote',
  isLocal: false,
  ocr: async () => {
    process.send?.({ type: 'provider-entered' });
    return new Promise(() => undefined);
  },
};
async function run(): Promise<void> {
  await storage.put('synthetic-image', Buffer.from('synthetic'));
  const config = loadConfig({
    NODE_ENV: 'test',
    DB_DRIVER: 'sqlite',
    AI_MAX_REMOTE_CALLS_PER_DOC: '1',
    WORKER_ENABLED: 'false',
  });
  const worker = buildServices({ db, config, provider, storage, logger: silentLogger }).worker;
  process.send?.({ type: 'ready' });
  process.on('message', (message) => {
    if (message === 'start')
      void worker.drain().then(
        () => process.send?.({ type: 'unexpected-completion' }),
        () => process.send?.({ type: 'error' }),
      );
  });
}
void run().catch(() => process.send?.({ type: 'error' }));
