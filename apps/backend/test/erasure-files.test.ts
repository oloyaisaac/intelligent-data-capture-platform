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
import { createHarness } from './helpers';

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
      await processErasureFiles(repo, storage, silentLogger, { userId: 'user-one', limit: 1 }),
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

it('rejects invalid user scopes and limits instead of widening the deletion sweep', async () => {
  const db = await createTestDatabase();
  try {
    const repo = new ErasureFilesRepository(db);
    for (const userId of ['', '  ']) {
      expect(() => repo.listPending({ userId })).toThrow('Invalid erasure user scope.');
    }
    for (const limit of [-1, 0, 101, 1.5, NaN, Infinity]) {
      expect(() => repo.listPending({ limit })).toThrow('Invalid erasure batch limit.');
    }
    expect(await repo.listPending({ limit: 100 })).toEqual([]);
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
    expect(
      await processErasureFiles(new ErasureFilesRepository(db), failedStorage, silentLogger),
    ).toBe(0);
    await db.close();
    db = new SqliteDatabase({ path });
    const reopenedStorage = new FilesystemStorage(join(dir, 'storage'));
    expect(
      await processErasureFiles(new ErasureFilesRepository(db), reopenedStorage, silentLogger),
    ).toBe(1);
    expect(await reopenedStorage.exists(key)).toBe(false);
    expect(await db.query('SELECT id FROM erasure_file_deletions')).toHaveLength(0);
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

it('rechecks a stale selection before deleting and leaves a replacement key alone', async () => {
  const db = await createTestDatabase();
  const storage = new MemoryStorage();
  const repo = new ErasureFilesRepository(db);
  const key = 'org/example/file.png';
  try {
    await storage.put(key, Buffer.from('old'));
    await db.execute(
      'INSERT INTO erasure_file_deletions (id, user_id, storage_key, created_at) VALUES (?, ?, ?, ?)',
      ['queue', 'user', key, '2026-01-01T00:00:00.000Z'],
    );
    const selected = await repo.listPending();
    const queue = {
      listPending: async () => selected,
      withLockedPending: repo.withLockedPending.bind(repo),
      recordFailedAttempt: repo.recordFailedAttempt.bind(repo),
    };
    expect(await processErasureFiles(queue, storage, silentLogger)).toBe(1);
    await storage.put(key, Buffer.from('replacement'));
    expect(await processErasureFiles(queue, storage, silentLogger)).toBe(0);
    expect((await storage.get(key)).toString()).toBe('replacement');
  } finally {
    await db.close();
  }
});

it('refuses a stale row whose key changed and does not record failure on the replacement', async () => {
  const db = await createTestDatabase();
  const repo = new ErasureFilesRepository(db);
  try {
    await db.execute(
      'INSERT INTO erasure_file_deletions (id, user_id, storage_key, created_at) VALUES (?, ?, ?, ?)',
      ['queue', 'user', 'org/old', '2026-01-01T00:00:00.000Z'],
    );
    const selected = (await repo.listPending())[0]!;
    await db.execute('UPDATE erasure_file_deletions SET storage_key = ? WHERE id = ?', [
      'org/new',
      'queue',
    ]);
    const action = jest.fn();
    expect(await repo.withLockedPending(selected, action)).toBe(false);
    expect(action).not.toHaveBeenCalled();
    await repo.recordFailedAttempt(selected.id, selected.storage_key, '2026-01-02T00:00:00.000Z');
    expect(await db.one('SELECT attempts, last_attempt_at FROM erasure_file_deletions')).toEqual({
      attempts: 0,
      last_attempt_at: null,
    });
  } finally {
    await db.close();
  }
});

it('keeps the queue when deletion removes bytes but reports failure, then retries', async () => {
  const db = await createTestDatabase();
  const storage = new MemoryStorage();
  const repo = new ErasureFilesRepository(db);
  const key = 'org/example/ambiguous';
  try {
    await storage.put(key, Buffer.from('sensitive'));
    await db.execute(
      'INSERT INTO erasure_file_deletions (id, user_id, storage_key, created_at) VALUES (?, ?, ?, ?)',
      ['queue', 'user', key, '2026-01-01T00:00:00.000Z'],
    );
    const remove = storage.delete.bind(storage);
    const mock = jest.spyOn(storage, 'delete').mockImplementationOnce(async (path) => {
      await remove(path);
      throw new Error('ambiguous deletion');
    });
    expect(await processErasureFiles(repo, storage, silentLogger)).toBe(0);
    expect(await storage.exists(key)).toBe(false);
    expect(await db.one('SELECT attempts FROM erasure_file_deletions')).toEqual({ attempts: 1 });
    mock.mockRestore();
    expect(await processErasureFiles(repo, storage, silentLogger)).toBe(1);
    expect(await repo.countForUser('user')).toBe(0);
  } finally {
    await db.close();
  }
});

it('serializes stale processors on the same SQLite adapter', async () => {
  const db = await createTestDatabase();
  const storage = new MemoryStorage();
  const repo = new ErasureFilesRepository(db);
  const key = 'org/example/sqlite-concurrency';
  let release!: () => void;
  const hold = new Promise<void>((resolve) => {
    release = resolve;
  });
  let started!: () => void;
  const deleting = new Promise<void>((resolve) => {
    started = resolve;
  });
  let first: Promise<number> | undefined;
  let second: Promise<number> | undefined;
  try {
    await storage.put(key, Buffer.from('original'));
    await db.execute(
      'INSERT INTO erasure_file_deletions (id, user_id, storage_key, created_at) VALUES (?, ?, ?, ?)',
      ['queue', 'user', key, '2026-01-01T00:00:00.000Z'],
    );
    const selected = await repo.listPending();
    const queue = {
      listPending: async () => selected,
      withLockedPending: repo.withLockedPending.bind(repo),
      recordFailedAttempt: repo.recordFailedAttempt.bind(repo),
    };
    const remove = storage.delete.bind(storage);
    const spy = jest.spyOn(storage, 'delete').mockImplementation(async (path) => {
      started();
      await hold;
      await remove(path);
      await storage.put(path, Buffer.from('replacement'));
    });
    first = processErasureFiles(queue, storage, silentLogger);
    void first.catch(() => undefined);
    await deleting;
    second = processErasureFiles(queue, storage, silentLogger);
    void second.catch(() => undefined);
    release();
    expect(await first).toBe(1);
    expect(await second).toBe(0);
    expect(spy).toHaveBeenCalledTimes(1);
    expect((await storage.get(key)).toString()).toBe('replacement');
  } finally {
    release();
    if (first) await first.catch(() => undefined);
    if (second) await second.catch(() => undefined);
    await db.close();
  }
});

it.each(['org/example/shared.png', 'org//example/shared.png'])(
  'retains both queue records and bytes when another row references %s',
  async (otherKey) => {
    const harness = await createHarness();
    const { db, storage } = harness;
    const repo = new ErasureFilesRepository(db);
    const key = 'org/example/shared.png';
    try {
      await storage.put(key, Buffer.from('sensitive'));
      await db.execute(
        'INSERT INTO erasure_file_deletions (id, user_id, storage_key, created_at) VALUES (?, ?, ?, ?)',
        ['a-selected', 'user-one', key, '2000-01-01T00:00:00.000Z'],
      );
      await db.execute(
        'INSERT INTO erasure_file_deletions (id, user_id, storage_key, created_at) VALUES (?, ?, ?, ?)',
        ['b-conflict', 'user-two', otherKey, '2000-01-01T00:00:00.000Z'],
      );
      const remove = jest.spyOn(storage, 'delete');
      expect(await processErasureFiles(repo, storage, silentLogger, { userId: 'user-one' })).toBe(
        0,
      );
      expect(remove).not.toHaveBeenCalled();
      expect((await storage.get(key)).toString()).toBe('sensitive');
      expect(await repo.countForUser('user-one')).toBe(1);
      expect(await repo.countForUser('user-two')).toBe(1);
      expect(
        await db.one('SELECT attempts FROM erasure_file_deletions WHERE id = ?', ['a-selected']),
      ).toEqual({ attempts: 1 });
      // This removes a synthetic test fixture, not an operational recommendation.
      await db.execute('DELETE FROM erasure_file_deletions WHERE id = ?', ['b-conflict']);
      expect(await processErasureFiles(repo, storage, silentLogger, { userId: 'user-one' })).toBe(
        1,
      );
      expect(await storage.exists(key)).toBe(false);
    } finally {
      await harness.close();
    }
  },
);
