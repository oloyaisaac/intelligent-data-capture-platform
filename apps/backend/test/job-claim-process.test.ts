import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { SqliteDatabase } from '../src/db/sqlite';
import { applyMigrations } from '../src/db/migrations';
import { JobsRepository } from '../src/repositories/system-repo';

/** Exercises claims only, not worker side effects, recovery, or the R01 two-server exercise. */
it('claims twenty SQLite jobs once across two separate processes', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'idcp-claims-'));
  const db = new SqliteDatabase({ path: join(directory, 'jobs.db') });
  const children: ChildProcess[] = [];
  const closed: Promise<void>[] = [];
  try {
    await applyMigrations(db);
    const repository = new JobsRepository(db);
    for (let i = 0; i < 20; i += 1) {
      await repository.enqueue({ organisationId: 'synthetic-org', type: 'synthetic-job' });
    }
    const launch = () => {
      const child = spawn(
        process.execPath,
        ['--import', 'tsx', 'test/fixtures/job-claim-process.ts', join(directory, 'jobs.db')],
        {
          cwd: resolve(__dirname, '..'),
          stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
        },
      );
      children.push(child);
      closed.push(new Promise<void>((resolveClose) => child.once('close', () => resolveClose())));
      let stderr = '';
      child.stderr?.on('data', (chunk: Buffer) => {
        stderr += chunk.toString();
      });
      let markReady!: () => void;
      let rejectReady!: (error: Error) => void;
      let receivedDone = false;
      const ready = new Promise<void>((resolveReady, reject) => {
        markReady = resolveReady;
        rejectReady = reject;
      });
      const done = new Promise<string[]>((resolveDone, reject) => {
        child.on('message', (message: unknown) => {
          if (!message || typeof message !== 'object' || !('type' in message)) return;
          const result = message as { type: string; claimed?: string[]; error?: string };
          if (result.type === 'ready') markReady();
          if (result.type === 'done') {
            receivedDone = true;
            resolveDone(result.claimed ?? []);
          }
          if (result.type === 'error') {
            const error = new Error(result.error ?? 'Claim process failed');
            rejectReady(error);
            reject(error);
          }
        });
        child.on('error', (error) => {
          rejectReady(error);
          reject(error);
        });
        child.on('exit', (code) => {
          if (code !== 0 || !receivedDone) {
            const error = new Error(
              `Claim process exited ${code} without a valid result: ${stderr}`,
            );
            rejectReady(error);
            reject(error);
          }
        });
      });
      // Attach immediately: a subprocess may fail before the parent has awaited the barrier.
      void done.catch(() => undefined);
      return { child, ready, done };
    };
    const a = launch();
    const b = launch();
    await Promise.all([a.ready, b.ready]);
    a.child.send?.('start');
    b.child.send?.('start');
    const results = await Promise.all([a.done, b.done]);
    const ids = results.flat();
    expect(ids).toHaveLength(20);
    expect(new Set(ids).size).toBe(20);
    const rows = await db.query<{ status: string; attempts: number }>(
      'SELECT status, attempts FROM jobs',
    );
    expect(rows).toHaveLength(20);
    expect(rows.every((row) => row.status === 'succeeded' && row.attempts === 1)).toBe(true);
  } finally {
    for (const child of children) {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    }
    await Promise.all(closed);
    await db.close();
    await rm(directory, { recursive: true, force: true });
  }
}, 30_000);
