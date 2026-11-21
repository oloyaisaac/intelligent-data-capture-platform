import {
  link,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FilesystemStorage } from '../src/storage';
import { createTestDatabase } from '../src/db';
import { buildApp } from '../src/http/app';
import { silentLogger } from '../src/logger';
import { buildServices } from '../src/services/container';
import { FakeOcrProvider, fakePng, testConfig } from './helpers';

const posixIt = process.platform === 'win32' ? it.skip : it;

posixIt(
  'refuses observed symlink roots and parents without creating or reading outside files',
  async () => {
    const directory = await mkdtemp(join(tmpdir(), 'idcp-access-links-'));
    const root = join(directory, 'storage');
    const outside = join(directory, 'outside');
    try {
      await mkdir(join(root, 'org/tenant'), { recursive: true });
      await mkdir(outside);
      await writeFile(join(outside, 'existing.png'), 'OUTSIDE-SECRET');
      await symlink(outside, join(root, 'org/tenant/documents'));
      const storage = new FilesystemStorage(root);
      const existing = 'org/tenant/documents/existing.png';
      const missing = 'org/tenant/documents/new/sub/file.png';
      await expect(storage.get(existing)).rejects.toMatchObject({ code: 'NOT_FOUND' });
      expect(await storage.exists(existing)).toBe(false);
      await expect(storage.put(missing, Buffer.from('data'))).rejects.toThrow(
        'Storage path is not a safe directory.',
      );
      await expect(lstat(join(outside, 'new'))).rejects.toMatchObject({ code: 'ENOENT' });
      expect(await readFile(join(outside, 'existing.png'), 'utf8')).toBe('OUTSIDE-SECRET');

      const rootLink = join(directory, 'root-link');
      await symlink(outside, rootLink);
      // Trailing separators must not make lstat follow the configured root link.
      const linkedStorage = new FilesystemStorage(`${rootLink}/`);
      await expect(linkedStorage.get('existing.png')).rejects.toMatchObject({ code: 'NOT_FOUND' });
      expect(await linkedStorage.exists('existing.png')).toBe(false);
      await expect(linkedStorage.put('new/file.png', Buffer.from('data'))).rejects.toThrow();
      await expect(lstat(join(outside, 'new'))).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(linkedStorage.delete('existing.png')).rejects.toThrow();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);

posixIt('does not read observed final symlinks, hardlinks or non-regular objects', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'idcp-access-files-'));
  try {
    const root = join(directory, 'storage');
    await mkdir(join(root, 'org'), { recursive: true });
    const original = join(directory, 'outside.txt');
    await writeFile(original, 'OUTSIDE-SECRET');
    await symlink(original, join(root, 'org/symlink'));
    await link(original, join(root, 'org/hardlink'));
    await mkdir(join(root, 'org/directory'));
    const storage = new FilesystemStorage(root);
    for (const key of ['org/symlink', 'org/hardlink', 'org/directory']) {
      await expect(storage.get(key)).rejects.toMatchObject({
        code: 'NOT_FOUND',
        message: 'File not found.',
      });
      expect(await storage.exists(key)).toBe(false);
    }
    expect(await readFile(original, 'utf8')).toBe('OUTSIDE-SECRET');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it('creates a missing storage root and regular parent directories on first write', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'idcp-access-new-'));
  try {
    const root = join(directory, 'new', 'storage');
    const storage = new FilesystemStorage(root);
    await storage.put('org/tenant/documents/a.png', Buffer.from('first'));
    await storage.put('org/tenant/documents/b.png', Buffer.from('second'));
    expect((await storage.get('org/tenant/documents/a.png')).toString()).toBe('first');
    expect(await storage.exists('org/tenant/documents/b.png')).toBe(true);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

posixIt('does not serve or upload through an observed symlink in the document API', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'idcp-access-api-'));
  const root = join(directory, 'storage');
  const outside = join(directory, 'outside');
  const db = await createTestDatabase();
  const services = buildServices({
    config: testConfig(),
    db,
    storage: new FilesystemStorage(root),
    logger: silentLogger,
    provider: new FakeOcrProvider(),
  });
  const app = await buildApp(services);
  try {
    await mkdir(outside);
    await app.listen({ port: 0, host: '127.0.0.1' });
    const address = app.server.address();
    if (!address || typeof address === 'string') throw new Error('No test listener');
    const base = `http://127.0.0.1:${address.port}`;
    const registered = await fetch(`${base}/api/v1/auth/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        email: 'filesystem-access@example.com',
        password: 'correct horse battery staple',
        displayName: 'Test User',
        organisationName: 'Test Ltd',
        acceptTerms: true,
      }),
    });
    expect(registered.status).toBe(201);
    const account = (await registered.json()) as {
      accessToken: string;
      user: { organisationId: string };
    };
    const upload = () => {
      const form = new FormData();
      form.append('file', new Blob([Uint8Array.from(fakePng())], { type: 'image/png' }), 'doc.png');
      return fetch(`${base}/api/v1/documents`, {
        method: 'POST',
        headers: { authorization: `Bearer ${account.accessToken}` },
        body: form,
      });
    };
    const first = await upload();
    expect(first.status).toBe(201);
    const { id } = (await first.json()) as { id: string };
    const row = await db.one<{ storage_key: string }>(
      'SELECT storage_key FROM documents WHERE id = ?',
      [id],
    );
    if (!row) throw new Error('Missing document');
    const outsideFile = join(outside, 'private.txt');
    await writeFile(outsideFile, 'OUTSIDE-SECRET');
    await rm(join(root, row.storage_key));
    await symlink(outsideFile, join(root, row.storage_key));
    const download = await fetch(`${base}/api/v1/documents/${id}/file`, {
      headers: { authorization: `Bearer ${account.accessToken}` },
    });
    expect(download.status).toBe(404);
    expect(await download.text()).not.toContain('OUTSIDE-SECRET');

    const tenantPath = join(root, 'org', account.user.organisationId);
    await rename(tenantPath, join(directory, 'original-tenant'));
    await symlink(outside, tenantPath);
    const rejected = await upload();
    expect(rejected.status).toBe(500);
    expect(await rejected.text()).not.toContain('OUTSIDE-SECRET');
    expect(await db.query('SELECT id FROM documents')).toHaveLength(1);
    await expect(lstat(join(outside, 'documents'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readFile(outsideFile, 'utf8')).toBe('OUTSIDE-SECRET');
  } finally {
    await app.close();
    await db.close();
    await rm(directory, { recursive: true, force: true });
  }
});
