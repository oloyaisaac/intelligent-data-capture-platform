import { spawnSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { SqliteDatabase } from '../src/db/sqlite';
import { applyMigrations } from '../src/db/migrations';
import { OrganisationsRepository } from '../src/repositories/auth-repo';
import { BatchesRepository } from '../src/repositories/batch-repo';
import { BATCH_FAILURE } from '../src/domain/batch-errors';

it('requires a scoped offline loss-reviewed command and never prints historical error text', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'idcp-batch-errors-'));
  const path = join(dir, 'db.sqlite');
  const db = new SqliteDatabase({ path });
  const cli = (...args: string[]) =>
    spawnSync(
      process.execPath,
      ['--import', 'tsx', 'src/db/batch-error-remediation-cli.ts', ...args],
      {
        cwd: resolve(__dirname, '..'),
        env: { PATH: process.env.PATH, NODE_ENV: 'test', DB_DRIVER: 'sqlite', SQLITE_PATH: path },
        encoding: 'utf8',
      },
    );
  try {
    await applyMigrations(db);
    const org = await new OrganisationsRepository(db).create({
      name: 'Test',
      slug: 'batch-remediation',
    });
    const repo = new BatchesRepository(db);
    const batch = await repo.create({
      organisationId: org.id,
      name: 'test',
      createdBy: 'operator',
    });
    await repo.addItem({
      batchId: batch.id,
      documentId: null,
      position: 0,
      error: 'SYNTHETIC-SECRET',
    });
    const scope = ['--organisation', org.id, '--batch', batch.id];
    const base = ['--apply', ...scope, '--operator', 'op', '--incident', 'INC-42'];
    for (const flags of [
      [],
      ['--confirm-offline'],
      ['--confirm-loss-reviewed'],
      ['--confirm-offline', '--confirm-loss-reviewed', '--extra'],
    ])
      expect(cli(...base, ...flags).status).toBe(1);
    expect(
      (
        await db.one<{ error: string }>('SELECT error FROM batch_items WHERE batch_id = ?', [
          batch.id,
        ])
      )?.error,
    ).toBe('SYNTHETIC-SECRET');
    const list = cli('--list', '--organisation', org.id, '--confirm-offline');
    expect(list.status).toBe(0);
    expect(JSON.parse(list.stdout)).toEqual({
      batches: [{ batchId: batch.id, eligible: 1 }],
      nextAfter: null,
    });
    expect(list.stdout + list.stderr).not.toContain('SYNTHETIC-SECRET');
    const check = cli('--check', ...scope, '--confirm-offline');
    expect(check.status).toBe(0);
    expect(JSON.parse(check.stdout)).toEqual({ found: true, eligible: 1 });
    expect(check.stdout + check.stderr).not.toContain('SYNTHETIC-SECRET');
    const wrong = cli(
      '--apply',
      '--organisation',
      'wrong-org',
      '--batch',
      batch.id,
      '--operator',
      'op',
      '--incident',
      'INC-42',
      '--confirm-offline',
      '--confirm-loss-reviewed',
    );
    expect(wrong.status).toBe(2);
    const result = cli(...base, '--confirm-offline', '--confirm-loss-reviewed');
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ found: true, changed: 1, remaining: false });
    expect(result.stdout + result.stderr).not.toContain('SYNTHETIC-SECRET');
    expect(
      (
        await db.one<{ error: string }>('SELECT error FROM batch_items WHERE batch_id = ?', [
          batch.id,
        ])
      )?.error,
    ).toBe(BATCH_FAILURE);
    expect(JSON.parse(cli('--check', ...scope, '--confirm-offline').stdout)).toEqual({
      found: true,
      eligible: 0,
    });
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
}, 30_000);
