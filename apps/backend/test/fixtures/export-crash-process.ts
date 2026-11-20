import { SqliteDatabase } from '../../src/db/sqlite';
import { loadConfig } from '../../src/config';
import { buildServices } from '../../src/services/container';
import { silentLogger } from '../../src/logger';
import { FilesystemStorage, type Storage } from '../../src/storage';

const [path, directory, organisationId] = process.argv.slice(2);
if (!path || !directory || !organisationId || !process.send)
  throw new Error('Missing fixture arguments');
const db = new SqliteDatabase({ path });
const disk = new FilesystemStorage(directory);
const storage: Storage = {
  driver: 'filesystem',
  put: async (key, data) => {
    await disk.put(key, data);
    process.send?.({ type: 'stored' });
    await new Promise<void>(() => undefined);
  },
  get: disk.get.bind(disk),
  delete: disk.delete.bind(disk),
  exists: disk.exists.bind(disk),
};
const config = loadConfig({
  NODE_ENV: 'test',
  DB_DRIVER: 'sqlite',
  JWT_SECRET: 'synthetic-test-secret-32-characters-long',
  WORKER_ENABLED: 'false',
});
const services = buildServices({ db, config, storage, logger: silentLogger });
void services.exports
  .create(
    { userId: 'synthetic-user', organisationId, role: 'owner', actorType: 'user' },
    { format: 'csv' },
  )
  .then(
    () => process.send?.({ type: 'unexpected-completion' }),
    () => process.send?.({ type: 'error' }),
  );
