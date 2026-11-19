import { existsSync } from 'node:fs';
import { loadEncryptionMigrationConfig } from '../config';
import { migrateEncryptionKeys } from '../services/encryption-migration';
import { EncryptionMigrationRepository } from '../repositories/encryption-migration-repo';
import { PostgresDatabase } from './postgres';
import { SqliteDatabase } from './sqlite';
import type { Database } from './database';

/** Offline command: does not apply schema migrations or start the API/worker. */
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
      throw new Error('SQLITE_PATH must point to an existing, persistent database.');
    }
    db = new SqliteDatabase({ path: config.SQLITE_PATH });
  }
  try {
    const report = await migrateEncryptionKeys(
      {
        transaction: (run) => db.transaction((tx) => run(new EncryptionMigrationRepository(tx))),
      },
      {
        encryptionSecret: config.ENCRYPTION_KEY,
        sourceSecret,
        mode,
      },
    );
    console.log(JSON.stringify(report));
    // A check is an actionable gate: a nonzero result means the old key must not be discarded.
    if (mode === 'check' && (report.connectors.legacy || report.mfa.legacy)) process.exitCode = 2;
  } finally {
    await db.close();
  }
}

main().catch(() => {
  // Driver/config errors can include connection strings; do not print raw exception text.
  console.error(
    'Encryption migration failed. Check database access, schema, key configuration, encrypted records and webhook/MFA blockers; see the migration runbook.',
  );
  process.exitCode = 1;
});
