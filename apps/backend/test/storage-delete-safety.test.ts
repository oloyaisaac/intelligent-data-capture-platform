import { link, mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTestDatabase } from '../src/db';
import { silentLogger } from '../src/logger';
import { ErasureFilesRepository } from '../src/repositories/erasure-files-repo';
import { processErasureFiles } from '../src/services/erasure-files';
import { FilesystemStorage } from '../src/storage';

it('refuses observed symlinks and hardlinks without deleting their targets', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'idcp-delete-safety-'));
  const root = join(dir, 'storage');
  const outside = join(dir, 'outside');
  const key = 'org/tenant/documents/file.png';
  try {
    await mkdir(join(root, 'org/tenant'), { recursive: true });
    await mkdir(outside);
    await writeFile(join(outside, 'file.png'), 'sensitive');
    const storage = new FilesystemStorage(root);

    await symlink(outside, join(root, 'org/tenant/documents'));
    await expect(storage.delete(key)).rejects.toThrow('Storage path cannot be safely deleted.');
    expect(await readFile(join(outside, 'file.png'), 'utf8')).toBe('sensitive');
    await rm(join(root, 'org/tenant/documents'));

    await mkdir(join(root, 'org/tenant/documents'));
    await symlink(join(outside, 'file.png'), join(root, key));
    await expect(storage.delete(key)).rejects.toThrow('Storage path cannot be safely deleted.');
    expect(await readFile(join(outside, 'file.png'), 'utf8')).toBe('sensitive');
    await rm(join(root, key));

    await link(join(outside, 'file.png'), join(root, key));
    await expect(storage.delete(key)).rejects.toThrow('Storage path cannot be safely deleted.');
    expect(await readFile(join(root, key), 'utf8')).toBe('sensitive');
    expect(await readFile(join(outside, 'file.png'), 'utf8')).toBe('sensitive');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

it('keeps an erasure queued for an observed symlink until the path is repaired', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'idcp-delete-queue-link-'));
  const root = join(dir, 'storage');
  const outside = join(dir, 'outside');
  const key = 'org/tenant/documents/file.png';
  const db = await createTestDatabase();
  try {
    await mkdir(join(root, 'org/tenant'), { recursive: true });
    await mkdir(outside);
    await writeFile(join(outside, 'file.png'), 'sensitive');
    await symlink(outside, join(root, 'org/tenant/documents'));
    await db.execute(
      'INSERT INTO erasure_file_deletions (id, user_id, storage_key, created_at) VALUES (?, ?, ?, ?)',
      ['deletion', 'user', key, '2026-01-01T00:00:00.000Z'],
    );
    const repo = new ErasureFilesRepository(db);
    const storage = new FilesystemStorage(root);
    expect(await processErasureFiles(repo, storage, silentLogger)).toBe(0);
    expect(await repo.countForUser('user')).toBe(1);
    expect(await readFile(join(outside, 'file.png'), 'utf8')).toBe('sensitive');
    // Simulate a separately authorized repair restoring the expected directory and object.
    await rm(join(root, 'org/tenant/documents'));
    await storage.put(key, Buffer.from('draft'));
    expect(await processErasureFiles(repo, storage, silentLogger)).toBe(1);
    expect(await repo.countForUser('user')).toBe(0);
    expect(await readFile(join(outside, 'file.png'), 'utf8')).toBe('sensitive');
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

it('keeps erasure work pending while the root is unavailable and retries after recovery', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'idcp-delete-root-'));
  const root = join(dir, 'storage');
  const key = 'org/tenant/documents/file.png';
  const db = await createTestDatabase();
  try {
    const storage = new FilesystemStorage(root);
    await storage.put(key, Buffer.from('sensitive'));
    await db.execute(
      'INSERT INTO erasure_file_deletions (id, user_id, storage_key, created_at) VALUES (?, ?, ?, ?)',
      ['deletion', 'user', key, '2026-01-01T00:00:00.000Z'],
    );
    // Model an unavailable mount without discarding the stored bytes.
    const offlineRoot = join(dir, 'offline');
    await rename(root, offlineRoot);
    const repo = new ErasureFilesRepository(db);
    expect(await processErasureFiles(repo, storage, silentLogger)).toBe(0);
    expect(
      await db.one('SELECT attempts FROM erasure_file_deletions WHERE id = ?', ['deletion']),
    ).toEqual({ attempts: 1 });
    expect(await readFile(join(offlineRoot, key), 'utf8')).toBe('sensitive');
    await rename(offlineRoot, root);
    expect(await processErasureFiles(repo, storage, silentLogger)).toBe(1);
    expect(await repo.countForUser('user')).toBe(0);
    await expect(storage.delete(key)).resolves.toBeUndefined();
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

it('refuses a symlink root and non-regular final entries', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'idcp-delete-root-link-'));
  try {
    const real = join(dir, 'real');
    await mkdir(join(real, 'org/item'), { recursive: true });
    await symlink(real, join(dir, 'root'));
    await expect(new FilesystemStorage(join(dir, 'root')).delete('org/item')).rejects.toThrow();
    await expect(new FilesystemStorage(real).delete('org/item')).rejects.toThrow();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
