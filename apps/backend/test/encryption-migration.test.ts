import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { applyMigrations } from '../src/db/migrations';
import type { Database } from '../src/db/database';
import { SqliteDatabase } from '../src/db/sqlite';
import { totp } from '../src/auth/totp';
import { createSecretBox } from '../src/services/crypto';
import { migrateEncryptionKeys as runMigration } from '../src/services/encryption-migration';
import { EncryptionMigrationRepository } from '../src/repositories/encryption-migration-repo';
import { buildServices } from '../src/services/container';
import { createHarness, registerAccount, type Harness } from './helpers';

function migrateEncryptionKeys(db: Database, input: Parameters<typeof runMigration>[1]) {
  return runMigration(
    { transaction: (run) => db.transaction((tx) => run(new EncryptionMigrationRepository(tx))) },
    input,
  );
}

const legacy = 'legacy-jwt-secret-0123456789abcdef';
const current = 'dedicated-encryption-key-0123456789';
const newJwt = 'a-rotated-jwt-secret-0123456789abcd';
const password = 'correct horse battery staple';
const totpSecret = 'JBSWY3DPEHPK3PXP';
const oldBox = createSecretBox(legacy);
const newBox = createSecretBox(current);
const options = { encryptionSecret: current, sourceSecret: legacy };

describe('offline encryption migration', () => {
  let harness: Harness;
  beforeEach(async () => {
    harness = await createHarness({ JWT_SECRET: legacy, ENCRYPTION_KEY: current });
  });
  afterEach(async () => {
    await harness.close();
  });

  async function addConnector(id: string, org: string, encrypted: string): Promise<void> {
    const now = new Date().toISOString();
    await harness.db.execute(
      `INSERT INTO connectors (id, organisation_id, type, name, config, credentials_encrypted, created_at, updated_at)
       VALUES (?, ?, 'csv', 'fixture', '{}', ?, ?, ?)`,
      [id, org, encrypted, now, now],
    );
  }

  it('checks without writes, migrates mixed connector and MFA values, then survives JWT rotation', async () => {
    const account = await registerAccount(harness);
    const other = await registerAccount(harness);
    const oldCredentials = oldBox.encrypt('{"apiKey":"legacy-token"}', account.organisationId);
    const newCredentials = newBox.encrypt('{"apiKey":"current-token"}', other.organisationId);
    const oldMfa = oldBox.encrypt(totpSecret, `mfa:${account.userId}`);
    const newMfa = newBox.encrypt(totpSecret, `mfa:${other.userId}`);
    await addConnector('a-old', account.organisationId, oldCredentials);
    await addConnector('b-new', other.organisationId, newCredentials);
    await harness.db.execute(
      'UPDATE users SET mfa_secret_enc = ?, mfa_enabled_at = ? WHERE id = ?',
      [oldMfa, new Date().toISOString(), account.userId],
    );
    await harness.db.execute('UPDATE users SET mfa_secret_enc = ? WHERE id = ?', [
      newMfa,
      other.userId,
    ]);
    const expected = {
      connectors: { alreadyCurrent: 1, legacy: 1 },
      mfa: { alreadyCurrent: 1, legacy: 1 },
    };
    expect(await migrateEncryptionKeys(harness.db, { ...options, mode: 'check' })).toMatchObject(
      expected,
    );
    expect(
      (await harness.db.one<{ credentials_encrypted: string }>(
        'SELECT credentials_encrypted FROM connectors WHERE id = ?',
        ['a-old'],
      ))!.credentials_encrypted,
    ).toBe(oldCredentials);
    expect(await migrateEncryptionKeys(harness.db, { ...options, mode: 'apply' })).toMatchObject(
      expected,
    );
    const oldRow = await harness.db.one<{ credentials_encrypted: string }>(
      'SELECT credentials_encrypted FROM connectors WHERE id = ?',
      ['a-old'],
    );
    const newRow = await harness.db.one<{ credentials_encrypted: string }>(
      'SELECT credentials_encrypted FROM connectors WHERE id = ?',
      ['b-new'],
    );
    expect(newRow!.credentials_encrypted).toBe(newCredentials);
    expect(oldRow!.credentials_encrypted).not.toBe(oldCredentials);
    const afterRotation = createSecretBox(current, newJwt);
    expect(afterRotation.decrypt(oldRow!.credentials_encrypted, account.organisationId)).toBe(
      '{"apiKey":"legacy-token"}',
    );
    expect(() => oldBox.decrypt(oldRow!.credentials_encrypted, account.organisationId)).toThrow();
    const user = await harness.db.one<{ mfa_secret_enc: string }>(
      'SELECT mfa_secret_enc FROM users WHERE id = ?',
      [account.userId],
    );
    expect(afterRotation.decrypt(user!.mfa_secret_enc, `mfa:${account.userId}`)).toBe(totpSecret);
    expect(() => afterRotation.decrypt(user!.mfa_secret_enc, `mfa:${other.userId}`)).toThrow();
    const login = await harness.api.json('POST', '/api/v1/auth/login', {
      body: { email: account.email, password },
    });
    expect(login.json()).toMatchObject({ mfaRequired: true });
    const verified = await harness.api.json('POST', '/api/v1/auth/mfa/verify', {
      body: {
        challengeToken: login.json<{ challengeToken: string }>().challengeToken,
        code: totp(totpSecret),
      },
    });
    expect(verified.statusCode).toBe(200);
    const rotated = buildServices({
      config: { ...harness.services.config, JWT_SECRET: newJwt },
      db: harness.db,
      storage: harness.storage,
      provider: harness.ocr,
      logger: harness.services.logger,
    });
    const rotatedLogin = await rotated.auth.login({ email: account.email, password });
    expect('mfaRequired' in rotatedLogin && rotatedLogin.mfaRequired).toBe(true);
    if (!('challengeToken' in rotatedLogin)) throw new Error('Expected MFA challenge');
    const rotatedSession = await rotated.auth.completeMfaLogin(
      rotatedLogin.challengeToken,
      totp(totpSecret),
    );
    expect(rotatedSession.accessToken).toBeTruthy();
    expect(await migrateEncryptionKeys(harness.db, { ...options, mode: 'apply' })).toMatchObject({
      connectors: { alreadyCurrent: 2, legacy: 0 },
      mfa: { alreadyCurrent: 2, legacy: 0 },
    });
  });

  it('rolls back earlier updates on a corrupt or unknown ciphertext', async () => {
    const account = await registerAccount(harness);
    const ciphertext = oldBox.encrypt('private', account.organisationId);
    await addConnector('a-valid', account.organisationId, ciphertext);
    await addConnector('z-invalid', account.organisationId, 'corrupt');
    await expect(migrateEncryptionKeys(harness.db, { ...options, mode: 'apply' })).rejects.toThrow(
      /cannot be decrypted/,
    );
    expect(
      (await harness.db.one<{ credentials_encrypted: string }>(
        'SELECT credentials_encrypted FROM connectors WHERE id = ?',
        ['a-valid'],
      ))!.credentials_encrypted,
    ).toBe(ciphertext);
    await expect(migrateEncryptionKeys(harness.db, { ...options, mode: 'check' })).rejects.toThrow(
      /cannot be decrypted/,
    );
  });

  it('can migrate from a previous dedicated encryption key after legacy JWT records are cleared', async () => {
    const account = await registerAccount(harness);
    const nextKey = 'the-next-dedicated-encryption-key-0123456789';
    const ciphertext = newBox.encrypt('separate-key-value', account.organisationId);
    await addConnector('key-rotation', account.organisationId, ciphertext);
    expect(
      await migrateEncryptionKeys(harness.db, {
        encryptionSecret: nextKey,
        sourceSecret: current,
        mode: 'apply',
      }),
    ).toMatchObject({ connectors: { legacy: 1 } });
    const row = await harness.db.one<{ credentials_encrypted: string }>(
      'SELECT credentials_encrypted FROM connectors WHERE id = ?',
      ['key-rotation'],
    );
    expect(
      createSecretBox(nextKey, newJwt).decrypt(row!.credentials_encrypted, account.organisationId),
    ).toBe('separate-key-value');
    expect(() => newBox.decrypt(row!.credentials_encrypted, account.organisationId)).toThrow();
  });

  it('fails when context, source key or key selection is wrong', async () => {
    const account = await registerAccount(harness);
    await addConnector(
      'wrong-context',
      account.organisationId,
      oldBox.encrypt('private', 'different-org'),
    );
    await expect(migrateEncryptionKeys(harness.db, { ...options, mode: 'check' })).rejects.toThrow(
      /cannot be decrypted/,
    );
    await harness.db.execute('UPDATE connectors SET credentials_encrypted = ? WHERE id = ?', [
      oldBox.encrypt('private', account.organisationId),
      'wrong-context',
    ]);
    await expect(
      migrateEncryptionKeys(harness.db, { ...options, sourceSecret: newJwt, mode: 'apply' }),
    ).rejects.toThrow(/cannot be decrypted/);
    await expect(
      migrateEncryptionKeys(harness.db, {
        encryptionSecret: legacy,
        sourceSecret: legacy,
        mode: 'check',
      }),
    ).rejects.toThrow(/must differ/);
  });

  it('fails closed on unhandled webhook secrets and enabled MFA without a secret', async () => {
    const account = await registerAccount(harness);
    const now = new Date().toISOString();
    await harness.db.execute(
      'INSERT INTO webhooks (id, organisation_id, url, events, secret_encrypted, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      ['webhook', account.organisationId, 'https://example.com', '[]', 'unknown', now],
    );
    await expect(migrateEncryptionKeys(harness.db, { ...options, mode: 'check' })).rejects.toThrow(
      /Webhook secrets/,
    );
    await harness.db.execute('DELETE FROM webhooks WHERE id = ?', ['webhook']);
    await harness.db.execute('UPDATE users SET mfa_enabled_at = ? WHERE id = ?', [
      now,
      account.userId,
    ]);
    await expect(migrateEncryptionKeys(harness.db, { ...options, mode: 'apply' })).rejects.toThrow(
      /enabled MFA account/,
    );
  });
});

it('keeps all PostgreSQL migration operations on the scoped transaction and locks before scanning', async () => {
  const statements: string[] = [];
  const tx: Database = {
    driver: 'postgres',
    query: async <T>(sql: string) => {
      statements.push(sql);
      return [] as T[];
    },
    one: async <T>(sql: string) => {
      statements.push(sql);
      return { count: 0 } as T;
    },
    execute: async (sql: string) => {
      statements.push(sql);
    },
    transaction: async (run) => run(tx),
    close: async () => undefined,
  };
  const outsideTransaction = async (): Promise<never> => {
    throw new Error('Unscoped database access');
  };
  const db: Database = {
    driver: 'postgres',
    query: outsideTransaction,
    one: outsideTransaction,
    execute: outsideTransaction,
    transaction: async (run) => run(tx),
    close: async () => undefined,
  };
  expect(await migrateEncryptionKeys(db, { ...options, mode: 'apply' })).toMatchObject({
    connectors: { alreadyCurrent: 0, legacy: 0 },
    mfa: { alreadyCurrent: 0, legacy: 0 },
  });
  expect(statements[0]).toBe('LOCK TABLE connectors, users, webhooks IN SHARE ROW EXCLUSIVE MODE');
  expect(statements.filter((sql) => sql.includes('FROM connectors'))).toHaveLength(2);
  expect(statements.filter((sql) => sql.includes('mfa_secret_enc IS NOT NULL'))).toHaveLength(2);
});

describe('offline migration CLI', () => {
  it('gates rotation until a persistent SQLite database has been migrated and checked', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'idcp-rekey-'));
    const path = join(directory, 'data.sqlite');
    const db = new SqliteDatabase({ path });
    try {
      await applyMigrations(db);
      const now = new Date().toISOString();
      await db.execute(
        'INSERT INTO organisations (id, name, slug, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
        ['org', 'Test', 'test', now, now],
      );
      await db.execute(
        `INSERT INTO connectors (id, organisation_id, type, name, credentials_encrypted, created_at, updated_at) VALUES (?, ?, 'csv', 'fixture', ?, ?, ?)`,
        ['one', 'org', oldBox.encrypt('sensitive', 'org'), now, now],
      );
      await db.close();
      const root = join(__dirname, '../../..');
      const cli = join(root, 'apps/backend/src/db/encryption-migration-cli.ts');
      const tsx = join(root, 'node_modules/tsx/dist/cli.mjs');
      const runWithEnv = (overrides: NodeJS.ProcessEnv, ...args: string[]) =>
        spawnSync(process.execPath, [tsx, cli, ...args], {
          cwd: root,
          encoding: 'utf8',
          env: {
            ...process.env,
            NODE_ENV: 'test',
            DB_DRIVER: 'sqlite',
            SQLITE_PATH: path,
            JWT_SECRET: legacy,
            ENCRYPTION_KEY: current,
            ENCRYPTION_MIGRATION_SOURCE_KEY: '',
            ...overrides,
          },
        });
      const run = (...args: string[]) => runWithEnv({}, ...args);
      const noJwt = runWithEnv({ JWT_SECRET: '' }, '--check', '--confirm-offline');
      const noEncryption = runWithEnv({ ENCRYPTION_KEY: '' }, '--check', '--confirm-offline');
      expect(noJwt.status).toBe(1);
      expect(noEncryption.status).toBe(1);
      const unsafe = run('--apply');
      expect(unsafe.status).toBe(1);
      const scan = run('--check', '--confirm-offline');
      expect(scan.status).toBe(2);
      expect(JSON.parse(scan.stdout).connectors.legacy).toBe(1);
      const apply = runWithEnv(
        { JWT_SECRET: newJwt, ENCRYPTION_MIGRATION_SOURCE_KEY: legacy },
        '--apply',
        '--confirm-offline',
      );
      expect(apply.status).toBe(0);
      const check = run('--check', '--confirm-offline');
      expect(check.status).toBe(0);
      expect(JSON.parse(check.stdout).connectors.legacy).toBe(0);
      expect([unsafe.stderr, scan.stdout, apply.stdout, check.stdout].join(' ')).not.toContain(
        'sensitive',
      );
      expect([unsafe.stderr, scan.stdout, apply.stdout, check.stdout].join(' ')).not.toContain(
        legacy,
      );
      const reopened = new SqliteDatabase({ path });
      try {
        const row = await reopened.one<{ credentials_encrypted: string }>(
          'SELECT credentials_encrypted FROM connectors WHERE id = ?',
          ['one'],
        );
        expect(createSecretBox(current, newJwt).decrypt(row!.credentials_encrypted, 'org')).toBe(
          'sensitive',
        );
      } finally {
        await reopened.close();
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
