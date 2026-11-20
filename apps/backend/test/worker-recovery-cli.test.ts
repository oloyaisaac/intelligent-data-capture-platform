import { spawnSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { SqliteDatabase } from '../src/db/sqlite';
import { applyMigrations } from '../src/db/migrations';
import { OrganisationsRepository } from '../src/repositories/auth-repo';
import { JobsRepository } from '../src/repositories/system-repo';

it('lists limited metadata and requeues only an explicitly selected running attempt', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'idcp-worker-recovery-cli-'));
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
    const org = await new OrganisationsRepository(db).create({ name: 'Test', slug: 'test' });
    const jobs = new JobsRepository(db);
    const target = await jobs.enqueue({
      organisationId: org.id,
      type: 'retention_purge',
      payload: { secret: 'synthetic-secret' },
    });
    const other = await jobs.enqueue({ organisationId: org.id, type: 'synthetic_other_job' });
    // Equal creation timestamps are ordered by random job id, not insertion order.
    const claimed = [(await jobs.claimNext())?.id, (await jobs.claimNext())?.id];
    expect(new Set(claimed)).toEqual(new Set([target.id, other.id]));

    const denied = cli('--requeue', target.id, '--attempt', '1', '--confirm-offline');
    expect(denied.status).toBe(1);
    expect(
      cli(
        '--requeue',
        target.id,
        '--attempt',
        '1',
        '--operator',
        'bad reference',
        '--incident',
        'INC-42',
        '--confirm-offline',
        '--confirm-effects-reviewed',
      ).status,
    ).toBe(1);
    expect((await jobs.findById(target.id))?.status).toBe('running');
    const list = cli('--list', '--confirm-offline');
    expect(list.status).toBe(0);
    expect(list.stdout).not.toContain('synthetic-secret');
    expect(JSON.parse(list.stdout)).toMatchObject({
      count: 2,
      truncated: false,
      jobs: expect.arrayContaining([
        expect.objectContaining({ id: target.id, attempts: 1 }),
        expect.objectContaining({ id: other.id, attempts: 1 }),
      ]),
    });
    expect(
      cli(
        '--requeue',
        target.id,
        '--attempt',
        '2',
        '--operator',
        'operator-1',
        '--incident',
        'INC-42',
        '--confirm-offline',
        '--confirm-effects-reviewed',
      ).status,
    ).toBe(2);
    expect((await jobs.findById(target.id))?.status).toBe('running');
    const recovered = cli(
      '--requeue',
      target.id,
      '--attempt',
      '1',
      '--operator',
      'operator-1',
      '--incident',
      'INC-42',
      '--confirm-offline',
      '--confirm-effects-reviewed',
    );
    expect(recovered.status).toBe(0);
    expect(JSON.parse(recovered.stdout)).toEqual({ requeued: true });
    expect((await jobs.findById(target.id))?.status).toBe('queued');
    expect((await jobs.findById(other.id))?.status).toBe('running');
    const audits = await db.query<{
      actor_type: string;
      actor_id: string | null;
      target_id: string;
      metadata: string;
    }>('SELECT actor_type, actor_id, target_id, metadata FROM audit_logs WHERE action = ?', [
      'worker.job_requeued_offline',
    ]);
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ actor_type: 'system', actor_id: null, target_id: target.id });
    expect(JSON.parse(audits[0]!.metadata)).toEqual({
      jobType: 'retention_purge',
      attempt: 1,
      operatorReference: 'operator-1',
      incidentReference: 'INC-42',
    });
    expect(audits[0]!.metadata).not.toContain('synthetic-secret');
    expect(
      cli(
        '--requeue',
        target.id,
        '--attempt',
        '1',
        '--operator',
        'operator-1',
        '--incident',
        'INC-42',
        '--confirm-offline',
        '--confirm-effects-reviewed',
      ).status,
    ).toBe(2);
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
}, 30_000);
