import { link, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FilesystemStorage, MemoryStorage, StorageKeyExistsError } from '../src/storage';

it('does not overwrite existing memory objects and allows a different fresh key', async () => {
  const storage = new MemoryStorage();
  await storage.put('org/a/documents/item.png', Buffer.from('original'));
  await expect(
    storage.put('org/a/documents/item.png', Buffer.from('replacement')),
  ).rejects.toBeInstanceOf(StorageKeyExistsError);
  expect((await storage.get('org/a/documents/item.png')).toString()).toBe('original');
  await storage.put('org/a/documents/other.png', Buffer.from('different'));
  expect((await storage.get('org/a/documents/other.png')).toString()).toBe('different');
});

it('atomically grants one filesystem writer and preserves the winner', async () => {
  const root = await mkdtemp(join(tmpdir(), 'idcp-exclusive-'));
  try {
    const storage = new FilesystemStorage(root);
    const key = 'org/a/documents/file.png';
    const payloads = Array.from({ length: 24 }, (_, i) => Buffer.from(`synthetic-writer-${i}`));
    const outcomes = await Promise.allSettled(payloads.map((payload) => storage.put(key, payload)));
    const winners = outcomes.flatMap((result, index) =>
      result.status === 'fulfilled' ? [index] : [],
    );
    expect(winners).toHaveLength(1);
    for (const result of outcomes)
      if (result.status === 'rejected') expect(result.reason).toBeInstanceOf(StorageKeyExistsError);
    expect(await storage.get(key)).toEqual(payloads[winners[0]!]!);
    expect((await readFile(join(root, key))).equals(payloads[winners[0]!]!)).toBe(true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it('refuses existing file aliases and final symlinks without changing their targets', async () => {
  if (process.platform === 'win32') return;
  const root = await mkdtemp(join(tmpdir(), 'idcp-exclusive-alias-'));
  try {
    await mkdir(join(root, 'org/a/documents'), { recursive: true });
    const original = join(root, 'org/a/documents/original.png');
    await writeFile(original, 'sensitive-original');
    await symlink(original, join(root, 'org/a/documents/link.png'));
    await link(original, join(root, 'org/a/documents/hardlink.png'));
    const storage = new FilesystemStorage(root);
    for (const key of [
      'org//a/documents/original.png',
      'org/a/documents/./original.png',
      'org/a/documents/link.png',
      'org/a/documents/hardlink.png',
    ]) {
      await expect(storage.put(key, Buffer.from('replacement'))).rejects.toBeInstanceOf(
        StorageKeyExistsError,
      );
    }
    expect((await readFile(original)).toString()).toBe('sensitive-original');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
