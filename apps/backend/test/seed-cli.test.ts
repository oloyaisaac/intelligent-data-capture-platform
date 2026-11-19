import { spawnSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { argon2Hasher } from '../src/auth/password';
import { SqliteDatabase } from '../src/db/sqlite';

it('uses injected seed settings and refuses to run in production', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'idcp-seed-'));
  const databasePath = join(directory, 'seed.sqlite');
  const root = join(__dirname, '../../..');
  const tsx = join(root, 'node_modules/tsx/dist/cli.mjs');
  const cli = join(root, 'apps/backend/src/db/seed-cli.ts');
  const cwd = join(root, 'apps/backend');
  const password = 'a synthetic seed passphrase';
  const env = {
    ...process.env,
    NODE_ENV: 'test',
    DB_DRIVER: 'sqlite',
    SQLITE_PATH: databasePath,
    STORAGE_DRIVER: 'filesystem',
    STORAGE_PATH: join(directory, 'documents'),
    JWT_SECRET: 'synthetic-jwt-secret-0123456789abcdef',
    ENCRYPTION_KEY: 'synthetic-encryption-key-0123456789',
    CORS_ORIGINS: 'https://example.com',
    AI_PROVIDER: 'local',
    MAIL_TRANSPORT: 'disabled',
    SEED_EMAIL: 'synthetic-seed@example.com',
    SEED_PASSWORD: password,
  };
  try {
    const result = spawnSync(process.execPath, [tsx, cli], { cwd, env, encoding: 'utf8' });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('synthetic-seed@example.com');
    const db = new SqliteDatabase({ path: databasePath });
    try {
      const user = await db.one<{ email: string; password_hash: string }>(
        'SELECT email, password_hash FROM users WHERE email = ?',
        ['synthetic-seed@example.com'],
      );
      expect(user?.email).toBe('synthetic-seed@example.com');
      expect(await argon2Hasher.verify(user!.password_hash, password)).toBe(true);
    } finally {
      await db.close();
    }
    const production = spawnSync(process.execPath, [tsx, cli], {
      cwd,
      env: { ...env, NODE_ENV: 'production', SEED_EMAIL: 'must-not-exist@example.com' },
      encoding: 'utf8',
    });
    expect(production.status).toBe(1);
    expect(production.stderr).toContain('Refusing to seed a production database');
    const check = new SqliteDatabase({ path: databasePath });
    try {
      expect(
        await check.one('SELECT id FROM users WHERE email = ?', ['must-not-exist@example.com']),
      ).toBeNull();
    } finally {
      await check.close();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
