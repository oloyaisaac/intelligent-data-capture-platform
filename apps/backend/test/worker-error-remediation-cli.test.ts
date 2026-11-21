import { spawnSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { SqliteDatabase } from '../src/db/sqlite';
import { applyMigrations } from '../src/db/migrations';
import { WORKER_ERROR_REDACTED } from '../src/domain/worker-errors';

it('requires scoped offline and loss-reviewed commands without printing original errors', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'idcp-worker-errors-'));
  const path = join(dir, 'db.sqlite');
  const db = new SqliteDatabase({ path });
  const cli = (...args: string[]) =>
    spawnSync(
      process.execPath,
      ['--import', 'tsx', 'src/db/worker-error-remediation-cli.ts', ...args],
      {
        cwd: resolve(__dirname, '..'),
        env: { PATH: process.env.PATH, NODE_ENV: 'test', DB_DRIVER: 'sqlite', SQLITE_PATH: path },
        encoding: 'utf8',
      },
    );
  try {
    await applyMigrations(db);
    await db.execute(
      `INSERT INTO jobs (id, organisation_id, type, status, last_error, created_at) VALUES (?, ?, 'extract_document', 'dead', ?, ?)`,
      ['fixture', 'org', 'SECRET-ERROR', '2026'],
    );
    const scope = ['--organisation', 'org', '--job', 'fixture'];
    const base = ['--apply', ...scope, '--operator', 'op', '--incident', 'INC-42'];
    for (const flags of [
      [],
      ['--confirm-offline'],
      ['--confirm-loss-reviewed'],
      ['--confirm-offline', '--confirm-loss-reviewed', '--extra'],
    ])
      expect(cli(...base, ...flags).status).toBe(1);
    expect(await db.one('SELECT last_error FROM jobs WHERE id = ?', ['fixture'])).toEqual({
      last_error: 'SECRET-ERROR',
    });
    const list = cli('--list', '--organisation', 'org', '--confirm-offline');
    expect(list.status).toBe(0);
    expect(JSON.parse(list.stdout)).toEqual({ jobs: [{ jobId: 'fixture' }], nextAfter: null });
    const check = cli('--check', ...scope, '--confirm-offline');
    expect(check.status).toBe(0);
    expect(JSON.parse(check.stdout)).toEqual({ found: true, eligible: true });
    const wrong = cli(
      '--check',
      '--organisation',
      'wrong-org',
      '--job',
      'fixture',
      '--confirm-offline',
    );
    expect(wrong.status).toBe(2);
    const result = cli(...base, '--confirm-offline', '--confirm-loss-reviewed');
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ found: true, changed: true });
    expect([list, check, wrong, result].map((r) => r.stdout + r.stderr).join('')).not.toContain(
      'SECRET-ERROR',
    );
    expect(await db.one('SELECT last_error FROM jobs WHERE id = ?', ['fixture'])).toEqual({
      last_error: WORKER_ERROR_REDACTED,
    });
    expect(JSON.parse(cli('--check', ...scope, '--confirm-offline').stdout)).toEqual({
      found: true,
      eligible: false,
    });
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
}, 30_000);
