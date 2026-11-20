import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ErasureFilesRepository } from '../src/repositories/erasure-files-repo';
import { silentLogger } from '../src/logger';
import { processErasureFiles } from '../src/services/erasure-files';
import { FilesystemStorage } from '../src/storage';
import { createHarness, registerAccount } from './helpers';

it('demonstrates that accepted non-canonical filesystem keys resolve to the same file', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'idcp-storage-alias-real-'));
  try {
    const storage = new FilesystemStorage(directory);
    await storage.put('org/one/documents/file.png', Buffer.from('synthetic'));
    expect((await storage.get('org//one/documents/file.png')).toString()).toBe('synthetic');
    expect((await storage.get('org/one/./documents/file.png')).toString()).toBe('synthetic');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it.each([
  'org//one/documents/file.png',
  'org/one/./documents/file.png',
  './org/one/documents/file.png',
  'org/one/documents/file.png/.',
  'org/one/documents/file.png/',
  '/org/one/documents/file.png',
  'org/one/other/../documents/file.png',
])('does not erase bytes while a legacy template references the path alias %s', async (alias) => {
  const harness = await createHarness();
  const directory = await mkdtemp(join(tmpdir(), 'idcp-storage-alias-'));
  const storage = new FilesystemStorage(directory);
  const key = 'org/one/documents/file.png';
  try {
    const account = await registerAccount(harness);
    await storage.put(key, Buffer.from('synthetic'));
    await harness.db.execute(
      `INSERT INTO templates (id, organisation_id, name, document_type, fields, sample_storage_key, created_at, updated_at)
       VALUES (?, ?, 'Legacy reference', 'invoice', '[]', ?, ?, ?)`,
      [
        'aliased-template',
        account.organisationId,
        alias,
        '2000-01-01T00:00:00.000Z',
        '2000-01-01T00:00:00.000Z',
      ],
    );
    await harness.db.execute(
      'INSERT INTO erasure_file_deletions (id, user_id, storage_key, created_at) VALUES (?, ?, ?, ?)',
      ['erase-alias', account.userId, key, '2000-01-01T00:00:00.000Z'],
    );
    const repo = new ErasureFilesRepository(harness.db);
    expect(await processErasureFiles(repo, storage, silentLogger)).toBe(0);
    expect(await storage.exists(key)).toBe(true);
    expect(
      await harness.db.one('SELECT attempts FROM erasure_file_deletions WHERE id = ?', [
        'erase-alias',
      ]),
    ).toEqual({ attempts: 1 });
    await harness.db.execute('UPDATE templates SET sample_storage_key = NULL WHERE id = ?', [
      'aliased-template',
    ]);
    expect(await processErasureFiles(repo, storage, silentLogger)).toBe(1);
    expect(await storage.exists(key)).toBe(false);
  } finally {
    await harness.close();
    await rm(directory, { recursive: true, force: true });
  }
});

it.each(['org//one/file.png', 'org/one/./file.png', 'org/one/file.png/', '../outside'])(
  'refuses to delete the non-canonical target %s even without known references',
  async (key) => {
    const harness = await createHarness();
    try {
      expect(await new ErasureFilesRepository(harness.db).isReferenced(key)).toBe(true);
    } finally {
      await harness.close();
    }
  },
);

it('finds an alias after the first bounded page and does not confuse distinct keys', async () => {
  const harness = await createHarness();
  try {
    const account = await registerAccount(harness);
    const parts: string[] = [];
    const values: string[] = [];
    for (let i = 0; i < 130; i += 1) {
      parts.push("(?, ?, 'Legacy', 'invoice', '[]', ?, ?, ?)");
      values.push(
        `a${String(i).padStart(3, '0')}`,
        account.organisationId,
        `org//other/file${i}.png`,
        '2000-01-01T00:00:00.000Z',
        '2000-01-01T00:00:00.000Z',
      );
    }
    parts.push("(?, ?, 'Legacy', 'invoice', '[]', ?, ?, ?)");
    values.push(
      'z-last',
      account.organisationId,
      'org//one/documents/file.png',
      '2000-01-01T00:00:00.000Z',
      '2000-01-01T00:00:00.000Z',
    );
    await harness.db.execute(
      `INSERT INTO templates (id, organisation_id, name, document_type, fields, sample_storage_key, created_at, updated_at) VALUES ${parts.join(', ')}`,
      values,
    );
    const repo = new ErasureFilesRepository(harness.db);
    expect(await repo.isReferenced('org/one/documents/file.png')).toBe(true);
    expect(await repo.isReferenced('org/one/documents/different.png')).toBe(false);
  } finally {
    await harness.close();
  }
});
