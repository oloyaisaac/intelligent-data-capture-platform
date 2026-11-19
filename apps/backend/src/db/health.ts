import type { Database } from './database';

/** Probe the active database connection; errors propagate to the readiness response. */
export async function checkDatabaseHealth(db: Database): Promise<void> {
  await db.one('SELECT 1 AS ok');
}
