import { spawnSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { SqliteDatabase } from '../src/db/sqlite';
import { applyMigrations } from '../src/db/migrations';
import { OrganisationsRepository } from '../src/repositories/auth-repo';
import { CONNECTOR_HEALTH_FAILURE, CONNECTOR_RUN_FAILURE } from '../src/domain/connector-errors';

it('requires scoped offline and loss-reviewed commands and never prints stored errors', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'idcp-connector-errors-'));
  const path = join(dir, 'db.sqlite');
  const db = new SqliteDatabase({ path });
  const cli = (...args: string[]) =>
    spawnSync(
      process.execPath,
      ['--import', 'tsx', 'src/db/connector-error-remediation-cli.ts', ...args],
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
      slug: 'connector-remediation',
    });
    await db.execute(
      `INSERT INTO connectors (id, organisation_id, type, name, status, last_error, created_at, updated_at)
      VALUES (?, ?, 'csv', 'fixture', 'error', ?, ?, ?)`,
      ['fixture', org.id, 'SECRET-HEALTH', '2026', '2026'],
    );
    await db.execute(
      `INSERT INTO connector_runs (id, organisation_id, connector_id, operation, status, error, created_at)
      VALUES (?, ?, ?, 'create', 'failed', ?, ?)`,
      ['fixture-run', org.id, 'fixture', 'SECRET-RUN', '2026'],
    );
    const scope = ['--organisation', org.id, '--connector', 'fixture'];
    const base = ['--apply', ...scope, '--operator', 'op', '--incident', 'INC-42'];
    for (const flags of [
      [],
      ['--confirm-offline'],
      ['--confirm-loss-reviewed'],
      ['--confirm-offline', '--confirm-loss-reviewed', '--extra'],
    ])
      expect(cli(...base, ...flags).status).toBe(1);
    expect(await db.one('SELECT last_error FROM connectors WHERE id = ?', ['fixture'])).toEqual({
      last_error: 'SECRET-HEALTH',
    });
    const list = cli('--list', '--organisation', org.id, '--confirm-offline');
    expect(list.status).toBe(0);
    expect(JSON.parse(list.stdout)).toEqual({
      connectors: [{ connectorId: 'fixture' }],
      nextAfter: null,
    });
    const check = cli('--check', ...scope, '--confirm-offline');
    expect(check.status).toBe(0);
    expect(JSON.parse(check.stdout)).toEqual({ found: true, healthEligible: true, runEligible: 1 });
    const wrong = cli(
      '--check',
      '--organisation',
      'wrong-org',
      '--connector',
      'fixture',
      '--confirm-offline',
    );
    expect(wrong.status).toBe(2);
    const result = cli(...base, '--confirm-offline', '--confirm-loss-reviewed');
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      found: true,
      healthChanged: true,
      runsChanged: 1,
      remaining: false,
    });
    expect([list, check, wrong, result].map((r) => r.stdout + r.stderr).join('')).not.toContain(
      'SECRET-',
    );
    expect(await db.one('SELECT last_error FROM connectors WHERE id = ?', ['fixture'])).toEqual({
      last_error: CONNECTOR_HEALTH_FAILURE,
    });
    expect(await db.one('SELECT error FROM connector_runs WHERE id = ?', ['fixture-run'])).toEqual({
      error: CONNECTOR_RUN_FAILURE,
    });
    expect(JSON.parse(cli('--check', ...scope, '--confirm-offline').stdout)).toEqual({
      found: true,
      healthEligible: false,
      runEligible: 0,
    });
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
}, 30_000);
