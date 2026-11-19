import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTestDatabase } from '../src/db';
import { applyMigrations } from '../src/db/migrations';
import { SqliteDatabase } from '../src/db/sqlite';
import { silentLogger } from '../src/logger';
import { processErasureFiles } from '../src/services/erasure-files';
import { ErasureFilesRepository } from '../src/repositories/erasure-files-repo';
import { FilesystemStorage, MemoryStorage } from '../src/storage';

it('limits and scopes deletion work to the requested user in stable order', async () => {
  const db = await createTestDatabase();
  const storage = new MemoryStorage();
  const repo = new ErasureFilesRepository(db);
  try {
    const items = [
      { id: 'b', user: 'user-one', key: 'org/one/b.png' },
      { id: 'a', user: 'user-one', key: 'org/one/a.png' },
      { id: 'c', user: 'user-two', key: 'org/two/c.png' },
    ];
    for (const item of items) {
      await storage.put(item.key, Buffer.from('synthetic'));
      await db.execute(
        'INSERT INTO erasure_file_deletions (id, user_id, storage_key, created_at) VALUES (?, ?, ?, ?)',
        [item.id, item.user, item.key, '2026-01-01T00:00:00.000Z'],
      );
    }
    expect(await repo.countForUser('user-one')).toBe(2);
    expect(
      await processErasureFiles(db, storage, silentLogger, { userId: 'user-one', limit: 1 }),
    ).toBe(1);
    expect(await storage.exists('org/one/a.png')).toBe(false);
    expect(await storage.exists('org/one/b.png')).toBe(true);
    expect(await storage.exists('org/two/c.png')).toBe(true);
    expect(await repo.countForUser('user-one')).toBe(1);
    expect(await repo.countForUser('user-two')).toBe(1);
  } finally {
    await db.close();
  }
});

it('retries a failed file deletion after reopening the database and storage', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'idcp-erasure-'));
  const path = join(dir, 'db.sqlite');
  const key = 'org/example/documents/file.png';
  let db = new SqliteDatabase({ path });
  try {
    await applyMigrations(db);
    const storage = new FilesystemStorage(join(dir, 'storage'));
    await storage.put(key, Buffer.from('sensitive'));
    await db.execute(
      'INSERT INTO erasure_file_deletions (id, user_id, storage_key, created_at) VALUES (?, ?, ?, ?)',
      ['deletion-1', 'erased-user', key, new Date().toISOString()],
    );
    const failedStorage = {
      ...storage,
      driver: storage.driver,
      put: storage.put.bind(storage),
      get: storage.get.bind(storage),
      exists: storage.exists.bind(storage),
      delete: jest.fn().mockRejectedValue(new Error('offline')),
    };
    expect(await processErasureFiles(db, failedStorage, silentLogger)).toBe(0);
    await db.close();
    db = new SqliteDatabase({ path });
    const reopenedStorage = new FilesystemStorage(join(dir, 'storage'));
    expect(await processErasureFiles(db, reopenedStorage, silentLogger)).toBe(1);
    expect(await reopenedStorage.exists(key)).toBe(false);
    expect(await db.query('SELECT id FROM erasure_file_deletions')).toHaveLength(0);
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});
