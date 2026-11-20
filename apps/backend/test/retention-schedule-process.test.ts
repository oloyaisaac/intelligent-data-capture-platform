import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { SqliteDatabase } from '../src/db/sqlite';
import { applyMigrations } from '../src/db/migrations';
import { OrganisationsRepository } from '../src/repositories/auth-repo';

it('coalesces concurrent retention schedules from two SQLite processes', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'idcp-retention-schedule-'));
  const path = join(directory, 'db.sqlite');
  const db = new SqliteDatabase({ path });
  const children: ChildProcess[] = [];
  const closed: Promise<void>[] = [];
  try {
    await applyMigrations(db);
    const organisation = await new OrganisationsRepository(db).create({
      name: 'Retention',
      slug: 'retention',
    });
    const launch = () => {
      const child = spawn(
        process.execPath,
        ['--import', 'tsx', 'test/fixtures/retention-schedule-process.ts', path, organisation.id],
        {
          cwd: resolve(__dirname, '..'),
          stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
        },
      );
      children.push(child);
      closed.push(new Promise<void>((done) => child.once('close', () => done())));
      let stderr = '';
      child.stderr?.on('data', (chunk: Buffer) => {
        stderr += chunk.toString();
      });
      let readyResolve!: () => void;
      let readyReject!: (error: Error) => void;
      let receivedDone = false;
      const ready = new Promise<void>((done, reject) => {
        readyResolve = done;
        readyReject = reject;
      });
      const done = new Promise<{ jobId: string; created: boolean }>((resolveDone, reject) => {
        child.on('message', (message: unknown) => {
          const event = message as {
            type?: string;
            jobId?: string;
            created?: boolean;
            message?: string;
          };
          if (event.type === 'ready') readyResolve();
          if (event.type === 'done' && event.jobId && typeof event.created === 'boolean') {
            receivedDone = true;
            resolveDone({ jobId: event.jobId, created: event.created });
          }
          if (event.type === 'error') {
            const error = new Error(event.message ?? 'child failed');
            readyReject(error);
            reject(error);
          }
        });
        child.on('error', (error) => {
          readyReject(error);
          reject(error);
        });
        child.on('exit', (code) => {
          if (code !== 0 || !receivedDone) {
            const error = new Error(
              `Schedule process exited ${code} without valid result: ${stderr}`,
            );
            readyReject(error);
            reject(error);
          }
        });
      });
      void done.catch(() => undefined);
      return { child, ready, done };
    };
    const first = launch();
    const second = launch();
    await Promise.all([first.ready, second.ready]);
    first.child.send?.('start');
    second.child.send?.('start');
    const results = await Promise.all([first.done, second.done]);
    expect(results[0]?.jobId).toBe(results[1]?.jobId);
    expect(results.filter((result) => result.created)).toHaveLength(1);
    const rows = await db.query<{ id: string }>(
      "SELECT id FROM jobs WHERE organisation_id = ? AND type = 'retention_purge'",
      [organisation.id],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toBe(results[0]?.jobId);
  } finally {
    for (const child of children)
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await Promise.all(closed);
    await db.close();
    await rm(directory, { recursive: true, force: true });
  }
}, 30_000);
