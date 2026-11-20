import { spawnSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { SqliteDatabase } from '../src/db/sqlite';
import { applyMigrations } from '../src/db/migrations';
import { OrganisationsRepository } from '../src/repositories/auth-repo';
import { JobsRepository } from '../src/repositories/system-repo';

it('requires explicit offline, effects-review and no-retry confirmations before audited abandonment', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'idcp-worker-abandon-cli-'));
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
    const org = await new OrganisationsRepository(db).create({
      name: 'Test',
      slug: 'test-abandon',
    });
    const jobs = new JobsRepository(db);
    const target = await jobs.enqueue({
      organisationId: org.id,
      type: 'retention_purge',
      payload: { secret: 'synthetic-secret' },
    });
    const other = await jobs.enqueue({ organisationId: org.id, type: 'unknown_job' });
    await db.execute("UPDATE jobs SET status = 'running', attempts = 1 WHERE id IN (?, ?)", [
      target.id,
      other.id,
    ]);
    const base = [
      '--abandon',
      target.id,
      '--attempt',
      '1',
      '--operator',
      'operator-1',
      '--incident',
      'INC-42',
    ];
    expect(cli(...base, '--confirm-offline', '--confirm-effects-reviewed').status).toBe(1);
    expect(cli(...base, '--confirm-offline', '--confirm-no-retry').status).toBe(1);
    expect(cli(...base, '--confirm-effects-reviewed', '--confirm-no-retry').status).toBe(1);
    expect(
      cli(
        ...base,
        '--confirm-offline',
        '--confirm-effects-reviewed',
        '--confirm-no-retry',
        '--extra',
      ).status,
    ).toBe(1);
    const invalid = [...base];
    invalid[5] = 'operator secret';
    expect(
      cli(...invalid, '--confirm-offline', '--confirm-effects-reviewed', '--confirm-no-retry')
        .status,
    ).toBe(1);
    expect((await jobs.findById(target.id))?.status).toBe('running');
    const wrongAttempt = [...base];
    wrongAttempt[3] = '2';
    expect(
      cli(...wrongAttempt, '--confirm-offline', '--confirm-effects-reviewed', '--confirm-no-retry')
        .status,
    ).toBe(2);
    const unknownType = [...base];
    unknownType[1] = other.id;
    expect(
      cli(...unknownType, '--confirm-offline', '--confirm-effects-reviewed', '--confirm-no-retry')
        .status,
    ).toBe(2);
    const result = cli(
      ...base,
      '--confirm-offline',
      '--confirm-effects-reviewed',
      '--confirm-no-retry',
    );
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ abandoned: true, documentFailed: false });
    expect(result.stdout + result.stderr).not.toContain('synthetic-secret');
    expect((await jobs.findById(target.id))?.status).toBe('dead');
    expect((await jobs.findById(other.id))?.status).toBe('running');
    expect(
      cli(...base, '--confirm-offline', '--confirm-effects-reviewed', '--confirm-no-retry').status,
    ).toBe(2);
    const audit = await db.query<{ metadata: string; actor_type: string; actor_id: string | null }>(
      'SELECT metadata, actor_type, actor_id FROM audit_logs WHERE action = ? AND target_id = ?',
      ['worker.job_abandoned_offline', target.id],
    );
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ actor_type: 'system', actor_id: null });
    expect(JSON.parse(audit[0]!.metadata)).toEqual({
      jobType: 'retention_purge',
      attempt: 1,
      operatorReference: 'operator-1',
      incidentReference: 'INC-42',
      documentFailed: false,
    });
    expect(audit[0]!.metadata).not.toContain('synthetic-secret');
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
}, 30_000);
