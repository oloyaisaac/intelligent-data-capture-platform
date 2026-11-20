import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { SqliteDatabase } from '../src/db/sqlite';
import { ReadOnlySqliteDatabase } from '../src/db/read-only-sqlite';
import { applyMigrations } from '../src/db/migrations';
import { OrganisationsRepository } from '../src/repositories/auth-repo';
import { ExportInventoryRepository } from '../src/repositories/export-inventory-repo';
import { inspectExportInventory, observeFile } from '../src/services/export-inventory';
import { buildStorageKey } from '../src/storage';
import { createHarness, registerAccount } from './helpers';

it('lists every export in pages and inspects a legacy candidate without modifying data', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'idcp-export-inventory-'));
  const path = join(dir, 'db.sqlite');
  const root = join(dir, 'storage');
  const db = new SqliteDatabase({ path });
  const cli = (...args: string[]) =>
    spawnSync(process.execPath, ['--import', 'tsx', 'src/db/export-inventory-cli.ts', ...args], {
      cwd: resolve(__dirname, '..'),
      env: {
        PATH: process.env.PATH,
        NODE_ENV: 'test',
        DB_DRIVER: 'sqlite',
        SQLITE_PATH: path,
        STORAGE_PATH: root,
      },
      encoding: 'utf8',
    });
  try {
    await applyMigrations(db);
    const org = await new OrganisationsRepository(db).create({
      name: 'Inventory',
      slug: 'inventory',
    });
    for (let i = 0; i < 102; i += 1) {
      await db.execute(
        `INSERT INTO exports (id, organisation_id, requested_by, format, filter, status, created_at)
        VALUES (?, ?, 'operator', 'csv', ?, 'failed', ?)`,
        [
          `id-${String(i).padStart(3, '0')}`,
          org.id,
          '{"secret":"SECRET-FILTER"}',
          '2000-01-01T00:00:00.000Z',
        ],
      );
    }
    const candidate = buildStorageKey({
      organisationId: org.id,
      id: 'id-000',
      kind: 'exports',
      extension: 'csv',
    });
    await mkdir(join(root, 'org', org.id, 'exports'), { recursive: true });
    await writeFile(join(root, ...candidate.split('/')), 'SECRET-CONTENT');
    await db.execute('UPDATE exports SET storage_key = ? WHERE id = ?', [candidate, 'id-001']);
    await db.execute(
      'INSERT INTO erasure_file_deletions (id, user_id, storage_key, created_at) VALUES (?, ?, ?, ?)',
      ['pending', 'user', candidate, '2000-01-01T00:00:00.000Z'],
    );
    const before = await db.query('SELECT * FROM exports ORDER BY id');
    expect(cli('--list').status).toBe(1);
    expect(cli('--inspect', 'id-000').status).toBe(1);
    const first = cli('--list', '--confirm-offline');
    expect(first.status).toBe(0);
    const page = JSON.parse(first.stdout) as {
      items: Array<{ id: string }>;
      nextAfter: string | null;
    };
    expect(page.items).toHaveLength(100);
    expect(page.nextAfter).toBe('id-099');
    const second = cli('--list', '--after', page.nextAfter!, '--confirm-offline');
    expect(second.status).toBe(0);
    expect(JSON.parse(second.stdout)).toMatchObject({
      items: [{ id: 'id-100' }, { id: 'id-101' }],
      nextAfter: null,
    });
    const inspected = cli('--inspect', 'id-000', '--confirm-offline');
    expect(inspected.status).toBe(0);
    expect(JSON.parse(inspected.stdout)).toMatchObject({
      found: true,
      export: { id: 'id-000', hasStoredKey: false, status: 'failed' },
      observations: [
        {
          source: 'canonicalCandidate',
          file: 'present',
          referencedElsewhere: true,
          pendingErasure: true,
        },
      ],
    });
    expect(inspected.stdout + first.stdout).not.toContain('SECRET-');
    expect(inspected.stdout).not.toContain(candidate);
    expect(cli('--inspect', 'missing-id', '--confirm-offline').status).toBe(2);
    expect(await db.query('SELECT * FROM exports ORDER BY id')).toEqual(before);
    expect(await db.query('SELECT id FROM erasure_file_deletions')).toHaveLength(1);
    const readonly = new ReadOnlySqliteDatabase(path);
    try {
      await expect(readonly.query("UPDATE exports SET status = 'expired'")).rejects.toThrow();
    } finally {
      await readonly.close();
    }
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
}, 30_000);

it('does not claim absence for a bad root, unsafe key, symlink or non-file', async () => {
  const root = await mkdtemp(join(tmpdir(), 'idcp-inventory-root-'));
  try {
    await mkdir(join(root, 'directory'));
    await symlink(join(root, 'directory'), join(root, 'alias'));
    expect(await observeFile(root, 'absent/file.csv')).toBe('missing');
    expect(await observeFile(join(root, 'absent-root'), 'file.csv')).toBe('unverifiable');
    expect(await observeFile(root, '../escape')).toBe('unverifiable');
    expect(await observeFile(root, 'alias/file.csv')).toBe('unverifiable');
    expect(await observeFile(root, 'directory')).toBe('unverifiable');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it('inspects references using the configured database driver without returning keys', async () => {
  const harness = await createHarness();
  const root = await mkdtemp(join(tmpdir(), 'idcp-inventory-driver-'));
  try {
    const account = await registerAccount(harness);
    const key = `org/${account.organisationId}/exports/private.csv`;
    await harness.db.execute(
      `INSERT INTO exports (id, organisation_id, requested_by, format, filter, storage_key, status, created_at)
      VALUES (?, ?, ?, 'csv', '{}', ?, 'queued', ?)`,
      ['inventory-record', account.organisationId, account.userId, key, '2000-01-01T00:00:00.000Z'],
    );
    await harness.db.execute(
      `INSERT INTO templates (id, organisation_id, name, document_type, fields, sample_storage_key, created_at, updated_at)
      VALUES (?, ?, 'Reference', 'invoice', '[]', ?, ?, ?)`,
      [
        'inventory-template',
        account.organisationId,
        key,
        '2000-01-01T00:00:00.000Z',
        '2000-01-01T00:00:00.000Z',
      ],
    );
    const result = await inspectExportInventory(
      new ExportInventoryRepository(harness.db),
      root,
      'inventory-record',
    );
    expect(result?.observations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          source: 'stored',
          file: 'missing',
          referencedElsewhere: true,
          pendingErasure: false,
        }),
      ]),
    );
    expect(JSON.stringify(result)).not.toContain(key);
  } finally {
    await harness.close();
    await rm(root, { recursive: true, force: true });
  }
});
