import { SqliteDatabase } from '../../src/db/sqlite';
import { JobsRepository } from '../../src/repositories/system-repo';

// Test-only subprocess. Parent starts all participants before allowing any claims.
const path = process.argv[2];
if (!path || !process.send) throw new Error('Database path and IPC channel are required');
const db = new SqliteDatabase({ path });
const jobs = new JobsRepository(db);
process.on('message', async (message: unknown) => {
  if (message !== 'start') return;
  const claimed: string[] = [];
  try {
    for (;;) {
      const job = await jobs.claimNext();
      if (!job) break;
      claimed.push(job.id);
      await jobs.markSucceeded(job.id);
    }
    await db.close();
    process.send?.({ type: 'done', claimed }, () => process.disconnect());
  } catch (error) {
    await db.close().catch(() => undefined);
    process.send?.(
      { type: 'error', error: error instanceof Error ? error.message : String(error) },
      () => process.disconnect(),
    );
  }
});
process.send({ type: 'ready' });
