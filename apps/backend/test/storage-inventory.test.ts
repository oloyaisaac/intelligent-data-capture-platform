import { spawnSync } from 'node:child_process';
import { link, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { applyMigrations } from '../src/db/migrations';
import { SqliteDatabase } from '../src/db/sqlite';
import { OrganisationsRepository } from '../src/repositories/auth-repo';
import { StorageInventoryRepository } from '../src/repositories/storage-inventory-repo';
import { DocumentsRepository } from '../src/repositories/document-repo';
import { listStorageInventory, listStorageReferences } from '../src/services/storage-inventory';
import { createHarness, registerAccount } from './helpers';

it('discovers unreferenced bytes, known cross-tenant aliases and pending erasure without modifying either store', async () => {
  const harness = await createHarness();
  const root = await mkdtemp(join(tmpdir(), 'idcp-storage-inventory-'));
  try {
    const owner = await registerAccount(harness);
    const other = await registerAccount(harness, {
      email: 'foreign-storage-inventory@example.com',
    });
    const directory = join(root, 'org', owner.organisationId, 'documents');
    await mkdir(directory, { recursive: true });
    for (let i = 0; i < 28; i++)
      await writeFile(
        join(directory, `file-${String(i).padStart(2, '0')}.png`),
        `SYNTHETIC-CONTENT-${i}`,
      );
    const referenced = `org/${owner.organisationId}/documents/file-00.png`;
    const pending = `org/${owner.organisationId}/documents/file-01.png`;
    await harness.db.execute(
      `INSERT INTO templates (id, organisation_id, name, document_type, fields, sample_storage_key, created_at, updated_at) VALUES (?, ?, 'Reference', 'invoice', '[]', ?, ?, ?)`,
      [
        'inventory-template',
        other.organisationId,
        referenced.replace('/documents/', '//documents/'),
        '2000-01-01T00:00:00.000Z',
        '2000-01-01T00:00:00.000Z',
      ],
    );
    await harness.db.execute(
      'INSERT INTO erasure_file_deletions (id, user_id, storage_key, created_at) VALUES (?, ?, ?, ?)',
      [
        'erase-pending',
        owner.userId,
        pending.replace('/documents/', '//documents/'),
        '2000-01-01T00:00:00.000Z',
      ],
    );
    await writeFile(join(directory, '.hidden'), 'unsupported');
    await writeFile(join(directory, 'unsupported name.png'), 'unsupported');
    await mkdir(join(directory, 'nested'));
    if (process.platform !== 'win32') {
      await symlink(join(directory, 'file-00.png'), join(directory, 'link.png'));
      await link(join(directory, 'file-00.png'), join(directory, 'hardlink.png'));
    }
    const repository = new StorageInventoryRepository(harness.db);
    const first = await listStorageInventory(
      repository,
      root,
      owner.organisationId,
      'documents',
      null,
    );
    expect(first.directory).toBe('present');
    expect(first.items).toHaveLength(25);
    expect(first.unsupportedNames).toBe(2);
    expect(first.nextAfter).not.toBeNull();
    expect(first.items.find((row) => row.key === referenced)).toMatchObject({
      file: 'regular',
      referenceMayExist: true,
      pendingErasureMayExist: false,
    });
    expect(first.items.find((row) => row.key === pending)).toMatchObject({
      file: 'regular',
      referenceMayExist: false,
      pendingErasureMayExist: true,
    });
    expect(first.items.find((row) => row.key.endsWith('file-02.png'))).toMatchObject({
      file: 'regular',
      referenceMayExist: false,
      pendingErasureMayExist: false,
    });
    const second = await listStorageInventory(
      repository,
      root,
      owner.organisationId,
      'documents',
      first.nextAfter,
    );
    expect(second.nextAfter).toBeNull();
    expect(second.unsupportedNames).toBe(2);
    const all = [...first.items, ...second.items];
    expect(new Set(all.map((entry) => entry.key)).size).toBe(
      process.platform === 'win32' ? 29 : 31,
    );
    expect(all.find((row) => row.key.endsWith('/nested'))).toMatchObject({
      file: 'unverifiable',
      referenceMayExist: null,
      pendingErasureMayExist: null,
    });
    if (process.platform !== 'win32') {
      expect(all.find((row) => row.key.endsWith('/link.png'))).toMatchObject({
        file: 'unverifiable',
        referenceMayExist: null,
      });
      expect(all.find((row) => row.key === referenced)?.hardlinkCount).toBe(2);
    }
    expect(JSON.stringify(all)).not.toContain('SYNTHETIC-CONTENT');
    expect((await readFile(join(directory, 'file-00.png'))).toString()).toBe('SYNTHETIC-CONTENT-0');
    expect(await harness.db.query('SELECT id FROM erasure_file_deletions')).toHaveLength(1);
    expect(
      await harness.db.query('SELECT id FROM templates WHERE id = ?', ['inventory-template']),
    ).toHaveLength(1);
  } finally {
    await harness.close();
    await rm(root, { recursive: true, force: true });
  }
}, 30_000);

it('fails closed on bad roots, symlink directories, invalid inputs and exceeded scan limit', async () => {
  const harness = await createHarness();
  const root = await mkdtemp(join(tmpdir(), 'idcp-inventory-safety-'));
  try {
    const repository = new StorageInventoryRepository(harness.db);
    const account = await registerAccount(harness);
    await expect(
      listStorageInventory(
        repository,
        join(root, 'missing'),
        account.organisationId,
        'documents',
        null,
      ),
    ).rejects.toThrow();
    expect(
      await listStorageInventory(repository, root, account.organisationId, 'documents', null),
    ).toMatchObject({ directory: 'missing', items: [] });
    for (const id of ['../escape', 'bad/name', '.hidden', ''])
      await expect(listStorageInventory(repository, root, id, 'documents', null)).rejects.toThrow();
    await expect(
      listStorageInventory(repository, root, account.organisationId, 'documents', '../escape'),
    ).rejects.toThrow();
    await expect(
      listStorageInventory(repository, root, account.organisationId, 'documents', null, {
        maxDirectoryEntries: 100001,
      }),
    ).rejects.toThrow();
    const dir = join(root, 'org', account.organisationId, 'documents');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'a.png'), 'a');
    await writeFile(join(dir, 'b.png'), 'b');
    await expect(
      listStorageInventory(repository, root, account.organisationId, 'documents', null, {
        maxDirectoryEntries: 1,
      }),
    ).rejects.toThrow();
    if (process.platform !== 'win32') {
      await symlink(dir, join(root, 'symlink-root'));
      await expect(
        listStorageInventory(
          repository,
          join(root, 'symlink-root'),
          account.organisationId,
          'documents',
          null,
        ),
      ).rejects.toThrow();
      await symlink(dir, join(root, 'org', account.organisationId, 'exports'));
      await expect(
        listStorageInventory(repository, root, account.organisationId, 'exports', null),
      ).rejects.toThrow();
    }
  } finally {
    await harness.close();
    await rm(root, { recursive: true, force: true });
  }
});

it('requires explicit offline and sensitive-output confirmations in the SQLite CLI', async () => {
  const root = await mkdtemp(join(tmpdir(), 'idcp-inventory-cli-'));
  const dbPath = join(root, 'database.sqlite');
  const storage = join(root, 'files');
  const db = new SqliteDatabase({ path: dbPath });
  const cli = (...args: string[]) =>
    spawnSync(process.execPath, ['--import', 'tsx', 'src/db/storage-inventory-cli.ts', ...args], {
      cwd: resolve(__dirname, '..'),
      env: {
        PATH: process.env.PATH,
        NODE_ENV: 'test',
        DB_DRIVER: 'sqlite',
        SQLITE_PATH: dbPath,
        STORAGE_PATH: storage,
      },
      encoding: 'utf8',
    });
  try {
    await applyMigrations(db);
    const org = await new OrganisationsRepository(db).create({
      name: 'Inventory',
      slug: 'storage-inventory',
    });
    const dir = join(storage, 'org', org.id, 'exports');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'orphan.csv'), 'SYNTHETIC-SECRET-CONTENT');
    const base = ['--list', '--organisation', org.id, '--kind', 'exports'];
    expect(cli(...base).status).toBe(1);
    expect(cli(...base, '--confirm-offline').status).toBe(1);
    expect(cli(...base, '--confirm-sensitive-output').status).toBe(1);
    expect(cli(...base, '--confirm-offline', '--confirm-sensitive-output', '--extra').status).toBe(
      1,
    );
    const key = `org/${org.id}/exports/orphan.csv`;
    await db.execute(
      `INSERT INTO exports (id, organisation_id, requested_by, format, filter, storage_key, status, created_at) VALUES (?, ?, 'operator', 'csv', '{}', ?, 'ready', ?)`,
      ['export-1', org.id, key, '2000-01-01T00:00:00.000Z'],
    );
    const references = cli(
      '--references',
      '--organisation',
      org.id,
      '--kind',
      'exports',
      '--confirm-offline',
      '--confirm-sensitive-output',
    );
    expect(references.status).toBe(0);
    expect(JSON.parse(references.stdout)).toMatchObject({
      items: [{ recordId: 'export-1', key, file: 'present', documentHasDeletedAt: null }],
      nextAfter: null,
    });
    const result = cli(...base, '--confirm-offline', '--confirm-sensitive-output');
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      directory: 'present',
      nextAfter: null,
      items: [
        {
          key: `org/${org.id}/exports/orphan.csv`,
          file: 'regular',
          referenceMayExist: true,
          pendingErasureMayExist: false,
        },
      ],
    });
    expect(result.stdout + result.stderr).not.toContain('SYNTHETIC-SECRET-CONTENT');
    expect((await readFile(join(dir, 'orphan.csv'))).toString()).toBe('SYNTHETIC-SECRET-CONTENT');
  } finally {
    await db.close();
    await rm(root, { recursive: true, force: true });
  }
}, 30_000);

it('lists scoped recorded document, page, export and template keys including missing and deleted references', async () => {
  const harness = await createHarness();
  const root = await mkdtemp(join(tmpdir(), 'idcp-reference-inventory-'));
  try {
    const account = await registerAccount(harness);
    const foreign = await registerAccount(harness, {
      email: 'foreign-reference-inventory@example.com',
    });
    const documents = new DocumentsRepository(harness.db);
    const dir = join(root, 'org', account.organisationId, 'documents');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'present.png'), 'SECRET-IMAGE-CONTENT');
    if (process.platform !== 'win32')
      await symlink(join(dir, 'present.png'), join(dir, 'link.png'));
    const keys = Array.from(
      { length: 27 },
      (_, i) =>
        `org/${account.organisationId}/documents/${i === 0 ? 'present' : i === 1 && process.platform !== 'win32' ? 'link' : `missing-${i}`}.png`,
    );
    const records: Array<{ id: string }> = [];
    for (const key of keys) {
      const row = await documents.createIfAbsent({
        organisationId: account.organisationId,
        storageKey: key,
        mimeType: 'image/png',
        sizeBytes: 1,
        sha256: 'synthetic',
      });
      if (!row) throw new Error('Synthetic document insert failed');
      records.push(row);
    }
    await harness.db.execute('UPDATE documents SET deleted_at = ? WHERE id = ?', [
      '2000-01-01T00:00:00.000Z',
      records[0]!.id,
    ]);
    const foreignDoc = await documents.createIfAbsent({
      organisationId: foreign.organisationId,
      storageKey: keys[0]!,
      mimeType: 'image/png',
      sizeBytes: 1,
      sha256: 'synthetic',
    });
    await harness.db.execute(
      'INSERT INTO document_pages (id, document_id, page_number, storage_key, ocr_text, created_at) VALUES (?, ?, 1, ?, ?, ?)',
      ['page-1', records[0]!.id, keys[0]!, 'SECRET-OCR-TEXT', '2000-01-01T00:00:00.000Z'],
    );
    await harness.db.execute(
      "INSERT INTO exports (id, organisation_id, requested_by, format, filter, storage_key, status, created_at) VALUES (?, ?, ?, 'csv', ?, ?, 'failed', ?)",
      [
        'export-1',
        account.organisationId,
        account.userId,
        'SECRET-EXPORT-FILTER',
        '../unsafe-key',
        '2000-01-01T00:00:00.000Z',
      ],
    );
    await harness.db.execute(
      "INSERT INTO templates (id, organisation_id, name, document_type, fields, sample_storage_key, created_at, updated_at) VALUES (?, ?, 'test', 'invoice', ?, ?, ?, ?)",
      [
        'template-1',
        account.organisationId,
        'SECRET-TEMPLATE-FIELDS',
        keys[0]!,
        '2000-01-01T00:00:00.000Z',
        '2000-01-01T00:00:00.000Z',
      ],
    );
    const repo = new StorageInventoryRepository(harness.db);
    const first = await listStorageReferences(
      repo,
      root,
      account.organisationId,
      'documents',
      null,
    );
    expect(first.items).toHaveLength(25);
    expect(first.nextAfter).not.toBeNull();
    const second = await listStorageReferences(
      repo,
      root,
      account.organisationId,
      'documents',
      first.nextAfter,
    );
    expect(second.items).toHaveLength(2);
    expect(second.nextAfter).toBeNull();
    const all = [...first.items, ...second.items];
    expect(new Set(all.map((item) => item.recordId)).size).toBe(27);
    expect(all.find((item) => item.recordId === records[0]!.id)).toMatchObject({
      key: keys[0],
      file: 'present',
      documentHasDeletedAt: true,
    });
    expect(all.find((item) => item.recordId === records[2]!.id)).toMatchObject({
      file: 'missing',
      documentHasDeletedAt: false,
    });
    if (process.platform !== 'win32')
      expect(all.find((item) => item.recordId === records[1]!.id)?.file).toBe('unverifiable');
    expect(all.some((item) => item.recordId === foreignDoc!.id)).toBe(false);
    expect(
      (await listStorageReferences(repo, root, account.organisationId, 'pages', null)).items,
    ).toEqual([{ recordId: 'page-1', key: keys[0], file: 'present', documentHasDeletedAt: true }]);
    expect(
      (await listStorageReferences(repo, root, account.organisationId, 'exports', null)).items,
    ).toEqual([
      {
        recordId: 'export-1',
        key: '../unsafe-key',
        file: 'unverifiable',
        documentHasDeletedAt: null,
      },
    ]);
    expect(
      (await listStorageReferences(repo, root, account.organisationId, 'templates', null)).items,
    ).toEqual([
      { recordId: 'template-1', key: keys[0], file: 'present', documentHasDeletedAt: null },
    ]);
    expect(
      JSON.stringify([
        all,
        await listStorageReferences(repo, root, account.organisationId, 'pages', null),
      ]),
    ).not.toContain('SECRET-');
    expect((await readFile(join(dir, 'present.png'))).toString()).toBe('SECRET-IMAGE-CONTENT');
    await expect(
      listStorageReferences(
        repo,
        join(root, 'nonexistent'),
        account.organisationId,
        'documents',
        null,
      ),
    ).rejects.toThrow();
  } finally {
    await harness.close();
    await rm(root, { recursive: true, force: true });
  }
}, 30_000);
