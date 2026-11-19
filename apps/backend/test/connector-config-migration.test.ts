import type { Database } from '../src/db/database';
import { ConnectorConfigMigrationRepository } from '../src/repositories/connector-config-migration-repo';
import { migrateConnectorConfigs } from '../src/services/connector-config-migration';
import { createSecretBox } from '../src/services/crypto';
import { createHarness, registerAccount } from './helpers';

function migrate(db: Database, box: ReturnType<typeof createSecretBox>, mode: 'check' | 'apply') {
  return migrateConnectorConfigs(
    {
      transaction: (run) => db.transaction((tx) => run(new ConnectorConfigMigrationRepository(tx))),
    },
    { read: box, target: box },
    mode,
  );
}

it('checks, migrates and verifies legacy configurations without changing credential precedence', async () => {
  const harness = await createHarness();
  const box = createSecretBox(harness.config.ENCRYPTION_KEY, harness.config.JWT_SECRET);
  try {
    const account = await registerAccount(harness);
    const create = await harness.api.json('POST', '/api/v1/connectors', {
      token: account.accessToken,
      body: { type: 'csv', name: 'new', config: { directory: '/tmp', filename: 'a.csv' } },
    });
    expect(create.statusCode).toBe(201);
    const now = new Date().toISOString();
    const encrypted = box.encrypt(
      JSON.stringify({ token: 'high-priority' }),
      account.organisationId,
    );
    await harness.db.execute(
      `INSERT INTO connectors (id, organisation_id, type, name, config, credentials_encrypted, created_at, updated_at)
       VALUES (?, ?, 'csv', 'legacy', ?, ?, ?, ?)`,
      [
        'legacy',
        account.organisationId,
        JSON.stringify({ token: 'plain-secret', directory: '/tmp', filename: 'b.csv' }),
        encrypted,
        now,
        now,
      ],
    );
    expect(await migrate(harness.db, box, 'check')).toEqual({
      mode: 'check',
      alreadyEncrypted: 1,
      plaintext: 1,
      sourceKey: 0,
    });
    const before = await harness.db.one<{ config: string }>(
      'SELECT config FROM connectors WHERE id = ?',
      ['legacy'],
    );
    expect(before?.config).toContain('plain-secret');
    expect(await migrate(harness.db, box, 'apply')).toEqual({
      mode: 'apply',
      alreadyEncrypted: 1,
      plaintext: 1,
      sourceKey: 0,
    });
    const row = await harness.db.one<{ config: string; credentials_encrypted: string }>(
      'SELECT config, credentials_encrypted FROM connectors WHERE id = ?',
      ['legacy'],
    );
    expect(JSON.stringify(row)).not.toContain('plain-secret');
    expect(JSON.stringify(row)).not.toContain('high-priority');
    expect(JSON.parse(box.decrypt(row!.credentials_encrypted, account.organisationId))).toEqual({
      config: { token: 'plain-secret', directory: '/tmp', filename: 'b.csv' },
      credentials: { token: 'high-priority' },
    });
    expect(await migrate(harness.db, box, 'check')).toEqual({
      mode: 'check',
      alreadyEncrypted: 2,
      plaintext: 0,
      sourceKey: 0,
    });
    expect(await migrate(harness.db, box, 'apply')).toEqual({
      mode: 'apply',
      alreadyEncrypted: 2,
      plaintext: 0,
      sourceKey: 0,
    });
  } finally {
    await harness.close();
  }
});

it('rolls back every update if a later row cannot be decrypted', async () => {
  const harness = await createHarness();
  const box = createSecretBox(harness.config.ENCRYPTION_KEY, harness.config.JWT_SECRET);
  try {
    const account = await registerAccount(harness);
    const now = new Date().toISOString();
    for (const [id, credentials] of [
      ['a', null],
      ['z', 'invalid-ciphertext'],
    ] as const) {
      await harness.db.execute(
        `INSERT INTO connectors (id, organisation_id, type, name, config, credentials_encrypted, created_at, updated_at)
         VALUES (?, ?, 'csv', 'legacy', ?, ?, ?, ?)`,
        [
          id,
          account.organisationId,
          JSON.stringify({ secret: 'rollback-secret' }),
          credentials,
          now,
          now,
        ],
      );
    }
    await expect(migrate(harness.db, box, 'apply')).rejects.toThrow();
    const rows = await harness.db.query<{ config: string }>(
      'SELECT config FROM connectors ORDER BY id',
    );
    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row.config.includes('rollback-secret'))).toBe(true);
  } finally {
    await harness.close();
  }
});

it('keeps encrypted configuration intact when the existing key-rotation tool rekeys it', async () => {
  const harness = await createHarness();
  try {
    const account = await registerAccount(harness);
    const created = await harness.api.json('POST', '/api/v1/connectors', {
      token: account.accessToken,
      body: {
        type: 'csv',
        name: 'rotated',
        config: { directory: '/tmp', filename: 'a.csv', extra: 'nested-secret' },
        credentials: { token: 'another-secret' },
      },
    });
    expect(created.statusCode).toBe(201);
    const nextKey = 'another-dedicated-encryption-key-12345';
    const { EncryptionMigrationRepository } =
      await import('../src/repositories/encryption-migration-repo');
    const { migrateEncryptionKeys } = await import('../src/services/encryption-migration');
    const result = await migrateEncryptionKeys(
      {
        transaction: (run) =>
          harness.db.transaction((tx) => run(new EncryptionMigrationRepository(tx))),
      },
      { encryptionSecret: nextKey, sourceSecret: harness.config.ENCRYPTION_KEY, mode: 'apply' },
    );
    expect(result.connectors.legacy).toBe(1);
    const id = created.json<{ id: string }>().id;
    const row = await harness.db.one<{ credentials_encrypted: string }>(
      'SELECT credentials_encrypted FROM connectors WHERE id = ?',
      [id],
    );
    const decoded = JSON.parse(
      createSecretBox(nextKey).decrypt(row!.credentials_encrypted, account.organisationId),
    );
    expect(decoded).toEqual({
      config: { directory: '/tmp', filename: 'a.csv', extra: 'nested-secret' },
      credentials: { token: 'another-secret' },
    });
  } finally {
    await harness.close();
  }
});

it('requires an offline acknowledgement and gates a SQLite rollout until configs are migrated', async () => {
  const { mkdtemp, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { spawnSync } = await import('node:child_process');
  const { SqliteDatabase } = await import('../src/db/sqlite');
  const { applyMigrations } = await import('../src/db/migrations');
  const dir = await mkdtemp(join(tmpdir(), 'idcp-config-migration-'));
  const path = join(dir, 'db.sqlite');
  const db = new SqliteDatabase({ path });
  try {
    await applyMigrations(db);
    const now = new Date().toISOString();
    await db.execute(
      'INSERT INTO organisations (id, name, slug, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
      ['org', 'Test', 'test', now, now],
    );
    await db.execute(
      `INSERT INTO connectors (id, organisation_id, type, name, config, created_at, updated_at) VALUES (?, ?, 'csv', 'legacy', ?, ?, ?)`,
      ['one', 'org', JSON.stringify({ secret: 'offline-plaintext' }), now, now],
    );
    await db.close();
    const root = join(__dirname, '../../..');
    const cli = join(root, 'apps/backend/src/db/connector-config-migration-cli.ts');
    const tsx = join(root, 'node_modules/tsx/dist/cli.mjs');
    const run = (...args: string[]) =>
      spawnSync(process.execPath, [tsx, cli, ...args], {
        cwd: root,
        encoding: 'utf8',
        env: {
          ...process.env,
          NODE_ENV: 'test',
          DB_DRIVER: 'sqlite',
          SQLITE_PATH: path,
          JWT_SECRET: 'legacy-jwt-key-0123456789abcdef',
          ENCRYPTION_KEY: 'current-encryption-key-0123456789abcdef',
          ENCRYPTION_MIGRATION_SOURCE_KEY: '',
        },
      });
    expect(run('--apply').status).toBe(1);
    const check = run('--check', '--confirm-offline');
    expect(check.status).toBe(2);
    expect(JSON.parse(check.stdout).plaintext).toBe(1);
    const apply = run('--apply', '--confirm-offline');
    expect(apply.status).toBe(0);
    expect(apply.stdout).not.toContain('offline-plaintext');
    const final = run('--check', '--confirm-offline');
    expect(final.status).toBe(0);
    expect(JSON.parse(final.stdout).plaintext).toBe(0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

it('does not report a clean migration while new-format config needs an offline-only source key', async () => {
  const { mkdtemp, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { spawnSync } = await import('node:child_process');
  const { SqliteDatabase } = await import('../src/db/sqlite');
  const { applyMigrations } = await import('../src/db/migrations');
  const { encodeConnectorConfig } = await import('../src/services/connector-config');
  const directory = await mkdtemp(join(tmpdir(), 'idcp-config-key-migration-'));
  const path = join(directory, 'db.sqlite');
  const target = 'target-encryption-key-0123456789abcdef';
  const source = 'old-external-source-key-0123456789abcdef';
  const jwt = 'different-runtime-jwt-key-0123456789abcdef';
  const db = new SqliteDatabase({ path });
  try {
    await applyMigrations(db);
    const now = new Date().toISOString();
    await db.execute(
      'INSERT INTO organisations (id, name, slug, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
      ['org', 'Test', 'test', now, now],
    );
    const parts = {
      config: { secret: 'source-only-secret' },
      credentials: { token: 'source-only-token' },
    };
    const encoded = encodeConnectorConfig(createSecretBox(source), 'org', parts);
    await db.execute(
      `INSERT INTO connectors (id, organisation_id, type, name, config, credentials_encrypted, created_at, updated_at) VALUES (?, ?, 'csv', 'fixture', ?, ?, ?, ?)`,
      ['one', 'org', JSON.stringify(encoded.config), encoded.credentialsEncrypted, now, now],
    );
    await db.close();
    const root = join(__dirname, '../../..');
    const cli = join(root, 'apps/backend/src/db/connector-config-migration-cli.ts');
    const tsx = join(root, 'node_modules/tsx/dist/cli.mjs');
    const run = (...args: string[]) =>
      spawnSync(process.execPath, [tsx, cli, ...args], {
        cwd: root,
        encoding: 'utf8',
        env: {
          ...process.env,
          NODE_ENV: 'test',
          DB_DRIVER: 'sqlite',
          SQLITE_PATH: path,
          JWT_SECRET: jwt,
          ENCRYPTION_KEY: target,
          ENCRYPTION_MIGRATION_SOURCE_KEY: source,
        },
      });
    const check = run('--check', '--confirm-offline');
    expect(check.status).toBe(2);
    expect(JSON.parse(check.stdout)).toMatchObject({ plaintext: 0, sourceKey: 1 });
    expect(run('--apply', '--confirm-offline').status).toBe(0);
    const final = run('--check', '--confirm-offline');
    expect(final.status).toBe(0);
    expect(JSON.parse(final.stdout)).toMatchObject({ plaintext: 0, sourceKey: 0 });
    const verified = new SqliteDatabase({ path });
    try {
      const row = await verified.one<{ credentials_encrypted: string }>(
        'SELECT credentials_encrypted FROM connectors WHERE id = ?',
        ['one'],
      );
      expect(
        JSON.parse(createSecretBox(target).decrypt(row!.credentials_encrypted, 'org')),
      ).toEqual(parts);
    } finally {
      await verified.close();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it('re-keys source-only new-format envelopes within the database transaction', async () => {
  const harness = await createHarness();
  try {
    const account = await registerAccount(harness);
    const source = 'source-envelope-key-0123456789abcdef';
    const target = 'target-envelope-key-0123456789abcdef';
    const { encodeConnectorConfig } = await import('../src/services/connector-config');
    const parts = { config: { secret: 'source-config' }, credentials: { token: 'source-token' } };
    const encoded = encodeConnectorConfig(createSecretBox(source), account.organisationId, parts);
    const now = new Date().toISOString();
    await harness.db.execute(
      `INSERT INTO connectors (id, organisation_id, type, name, config, credentials_encrypted, created_at, updated_at) VALUES (?, ?, 'csv', 'source', ?, ?, ?, ?)`,
      [
        'source-row',
        account.organisationId,
        JSON.stringify(encoded.config),
        encoded.credentialsEncrypted,
        now,
        now,
      ],
    );
    const transaction = {
      transaction: <T>(run: (records: ConnectorConfigMigrationRepository) => Promise<T>) =>
        harness.db.transaction((tx) => run(new ConnectorConfigMigrationRepository(tx))),
    };
    const boxes = { read: createSecretBox(target, source), target: createSecretBox(target) };
    expect(await migrateConnectorConfigs(transaction, boxes, 'check')).toMatchObject({
      plaintext: 0,
      alreadyEncrypted: 1,
      sourceKey: 1,
    });
    expect(await migrateConnectorConfigs(transaction, boxes, 'apply')).toMatchObject({
      plaintext: 0,
      alreadyEncrypted: 1,
      sourceKey: 1,
    });
    expect(await migrateConnectorConfigs(transaction, boxes, 'check')).toMatchObject({
      plaintext: 0,
      alreadyEncrypted: 1,
      sourceKey: 0,
    });
    const row = await harness.db.one<{ credentials_encrypted: string }>(
      'SELECT credentials_encrypted FROM connectors WHERE id = ?',
      ['source-row'],
    );
    expect(
      JSON.parse(boxes.target.decrypt(row!.credentials_encrypted, account.organisationId)),
    ).toEqual(parts);
  } finally {
    await harness.close();
  }
});
