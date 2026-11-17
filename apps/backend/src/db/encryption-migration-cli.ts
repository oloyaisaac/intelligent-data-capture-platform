import { existsSync } from 'node:fs';
import { loadConfig } from '../config';
import { migrateEncryptionKeys } from '../services/encryption-migration';
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
  const config = loadConfig();
  if (
    !process.env.JWT_SECRET ||
    !process.env.ENCRYPTION_KEY ||
    config.ENCRYPTION_KEY.length < 32 ||
    config.ENCRYPTION_KEY === 'local-encryption-secret-do-not-use-in-production' ||
    config.JWT_SECRET === config.ENCRYPTION_KEY
  ) {
    throw new Error(
      'Explicit, distinct JWT_SECRET and a non-default ENCRYPTION_KEY of at least 32 characters are required.',
    );
  }
  const sourceSecret = process.env.ENCRYPTION_MIGRATION_SOURCE_KEY || config.JWT_SECRET;
  if (sourceSecret.length < 16 || sourceSecret === config.ENCRYPTION_KEY) {
    throw new Error('The source key must have at least 16 characters and differ from the target.');
  }
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
    const report = await migrateEncryptionKeys(db, {
      encryptionSecret: config.ENCRYPTION_KEY,
      sourceSecret,
      mode,
    });
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
