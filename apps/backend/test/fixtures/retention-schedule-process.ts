import { SqliteDatabase } from '../../src/db/sqlite';
import { JobsRepository } from '../../src/repositories/system-repo';

const path = process.argv[2];
const organisationId = process.argv[3];
if (!path || !organisationId || !process.send)
  throw new Error('Database, organisation and IPC required');
const db = new SqliteDatabase({ path });
const jobs = new JobsRepository(db);
process.on('message', (message: unknown) => {
  if (message !== 'start') return;
  void (async () => {
    const result = await jobs.enqueueRetentionIfAbsent({ organisationId, onlyEnabled: true });
    await db.close();
    process.send?.({ type: 'done', jobId: result.job?.id, created: result.created }, () =>
      process.disconnect(),
    );
  })().catch(async (error: unknown) => {
    await db.close().catch(() => undefined);
    process.send?.(
      { type: 'error', message: error instanceof Error ? error.message : 'unknown error' },
      () => process.disconnect(),
    );
  });
});
process.send({ type: 'ready' });
