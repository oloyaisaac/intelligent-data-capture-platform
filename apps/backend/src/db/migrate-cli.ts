import { loadConfig } from '../config';
import { createLogger } from '../logger';
import { createDatabase } from './index';

/** `npm run db:migrate` — applies all pending migrations and reports what ran. */
async function main(): Promise<void> {
  const config = loadConfig();
  const logger = createLogger({ level: config.LOG_LEVEL, base: { task: 'migrate' } });
  const db = await createDatabase(config, logger);
  const rows = await db.query<{ id: string; applied_at: string }>(
    'SELECT id, applied_at FROM schema_migrations ORDER BY id',
  );
  console.log(`Applied migrations (${rows.length}):`);
  for (const row of rows) console.log(`  ${row.id}  ${row.applied_at}`);
  await db.close();
}

main().catch((error: unknown) => {
  console.error('Migration failed:', error instanceof Error ? error.message : error);
  process.exit(1);
});
