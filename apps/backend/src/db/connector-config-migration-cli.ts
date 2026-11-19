import { existsSync } from 'node:fs';
import { loadEncryptionMigrationConfig } from '../config';
import { ConnectorConfigMigrationRepository } from '../repositories/connector-config-migration-repo';
import { migrateConnectorConfigs } from '../services/connector-config-migration';
import { createSecretBox } from '../services/crypto';
import type { Database } from './database';
import { PostgresDatabase } from './postgres';
import { SqliteDatabase } from './sqlite';

/** Offline only: does not apply schema migrations or start the API or worker. */
async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const mode = args.includes('--check') ? 'check' : args.includes('--apply') ? 'apply' : null;
  if (
    !mode ||
    args.length !== 2 ||
    !args.includes('--confirm-offline') ||
    (args.includes('--check') && args.includes('--apply'))
  ) {
    throw new Error('Use exactly --check or --apply, plus --confirm-offline.');
  }
  const { config, sourceSecret } = loadEncryptionMigrationConfig();
  let db: Database;
  if (config.DB_DRIVER === 'postgres') {
    db = new PostgresDatabase({ connectionString: config.DATABASE_URL!, poolSize: 1 });
  } else {
    if (config.SQLITE_PATH === ':memory:' || !existsSync(config.SQLITE_PATH)) {
      throw new Error('SQLITE_PATH must point to an existing persistent database.');
    }
    db = new SqliteDatabase({ path: config.SQLITE_PATH });
  }
  try {
    const report = await migrateConnectorConfigs(
      {
        transaction: (run) =>
          db.transaction((tx) => run(new ConnectorConfigMigrationRepository(tx))),
      },
      {
        read: createSecretBox(config.ENCRYPTION_KEY, sourceSecret),
        target: createSecretBox(config.ENCRYPTION_KEY),
      },
      mode,
    );
    console.log(JSON.stringify(report));
    if (mode === 'check' && (report.plaintext > 0 || report.sourceKey > 0)) process.exitCode = 2;
  } finally {
    await db.close();
  }
}

main().catch(() => {
  // Do not expose driver errors, config, credentials, ciphertext, row IDs or connection strings.
  console.error(
    'Connector config migration failed. Verify offline operation, database access, schema and encryption keys; see the migration runbook.',
  );
  process.exitCode = 1;
});
