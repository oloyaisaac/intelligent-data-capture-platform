import { spawnSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { SqliteDatabase } from '../src/db/sqlite';
import { applyMigrations } from '../src/db/migrations';

it('paginates all offline running claims without exposing payload or errors', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'idcp-worker-inventory-'));
  const path = join(dir, 'db.sqlite');
  const db = new SqliteDatabase({ path });
  const cli = (...args: string[]) =>
    spawnSync(process.execPath, ['--import', 'tsx', 'src/db/worker-recovery-cli.ts', ...args], {
      cwd: resolve(__dirname, '..'),
      env: { PATH: process.env.PATH, NODE_ENV: 'test', DB_DRIVER: 'sqlite', SQLITE_PATH: path },
      encoding: 'utf8',
    });
  try {
    await applyMigrations(db);
    await db.transaction(async (tx) => {
      for (let i = 0; i < 1003; i += 1) {
        await tx.execute(
          `INSERT INTO jobs (id, organisation_id, type, status, attempts, payload, last_error, created_at)
           VALUES (?, 'org', 'retention_purge', 'running', 1, ?, ?, ?)`,
          [
            `job-${String(i).padStart(4, '0')}`,
            'synthetic-secret-payload',
            'synthetic-secret-error',
            '2000-01-01T00:00:00.000Z',
          ],
        );
      }
      await tx.execute(
        `INSERT INTO jobs (id, organisation_id, type, status, attempts, created_at)
         VALUES ('job-9999', 'org', 'retention_purge', 'queued', 0, ?)`,
        ['2000-01-01T00:00:00.000Z'],
      );
    });
    expect(cli('--list', '--after', 'job-0000').status).toBe(1);
    expect(cli('--list', '--after', 'x'.repeat(257), '--confirm-offline').status).toBe(1);
    const first = cli('--list', '--confirm-offline');
    expect(first.status).toBe(0);
    expect(first.stdout).not.toContain('synthetic-secret');
    const page = JSON.parse(first.stdout) as {
      count: number;
      jobs: Array<{ id: string }>;
      truncated: boolean;
      nextAfter: string | null;
    };
    expect(page.count).toBe(1003);
    expect(page.jobs).toHaveLength(1000);
    expect(page.truncated).toBe(true);
    expect(page.nextAfter).toBe('job-0999');
    const second = cli('--list', '--after', page.nextAfter!, '--confirm-offline');
    expect(second.status).toBe(0);
    expect(second.stdout).not.toContain('synthetic-secret');
    const next = JSON.parse(second.stdout) as typeof page;
    expect(next.count).toBe(1003);
    expect(next.jobs.map((row) => row.id)).toEqual(['job-1000', 'job-1001', 'job-1002']);
    expect(next.truncated).toBe(false);
    expect(next.nextAfter).toBeNull();
    expect(new Set([...page.jobs, ...next.jobs].map((row) => row.id)).size).toBe(1003);
    const beyond = cli('--list', '--after', 'job-9999', '--confirm-offline');
    expect(beyond.status).toBe(0);
    expect(JSON.parse(beyond.stdout)).toEqual({
      count: 1003,
      jobs: [],
      truncated: false,
      nextAfter: null,
    });
    expect(
      await db.one<{ count: number }>(
        "SELECT COUNT(*) AS count FROM jobs WHERE status = 'running'",
      ),
    ).toEqual({ count: 1003 });
    expect(await db.query('SELECT id FROM audit_logs')).toHaveLength(0);
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
}, 30_000);
