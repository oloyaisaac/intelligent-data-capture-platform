import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { SqliteDatabase } from '../src/db/sqlite';
import { applyMigrations } from '../src/db/migrations';
import { OrganisationsRepository } from '../src/repositories/auth-repo';
import { DocumentPagesRepository, DocumentsRepository } from '../src/repositories/document-repo';
import { JobsRepository } from '../src/repositories/system-repo';

/** Narrow safety test: startup must not reclaim a still-live claim based on age alone. */
it('a second worker does not reclaim a live artificially aged SQLite claim at startup', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'idcp-stale-live-worker-'));
  const path = join(directory, 'db.sqlite');
  const db = new SqliteDatabase({ path });
  const children: ChildProcess[] = [];
  const exits: Promise<void>[] = [];
  const errors: string[] = [];
  const events: Array<Array<string>> = [];
  const waiters: Array<Map<string, () => void>> = [];
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await applyMigrations(db);
    const org = await new OrganisationsRepository(db).create({
      name: 'Live test',
      slug: 'live-test',
    });
    const document = await new DocumentsRepository(db).createIfAbsent({
      organisationId: org.id,
      storageKey: 'synthetic-image',
      mimeType: 'image/png',
      sizeBytes: 9,
      sha256: 'synthetic',
      status: 'queued',
    });
    expect(document).not.toBeNull();
    await new DocumentPagesRepository(db).create({
      documentId: document!.id,
      pageNumber: 1,
      storageKey: 'synthetic-image',
    });
    const jobs = new JobsRepository(db);
    const job = await jobs.enqueue({
      organisationId: org.id,
      type: 'extract_document',
      documentId: document!.id,
    });

    const launch = (mode: 'hold' | 'recover') => {
      const index = children.length;
      events[index] = [];
      waiters[index] = new Map();
      const child = spawn(
        process.execPath,
        ['--import', 'tsx', 'test/fixtures/worker-stale-process.ts', path, mode],
        {
          cwd: resolve(__dirname, '..'),
          stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
        },
      );
      children.push(child);
      exits.push(new Promise((done) => child.once('close', () => done())));
      // Consume Node's SQLite experimental warning without treating it as a worker failure.
      child.stderr?.on('data', () => undefined);
      child.on('message', (message: unknown) => {
        if (!message || typeof message !== 'object' || !('type' in message)) return;
        const event = message as { type: string; message?: string };
        if (event.type === 'error') errors.push(event.message ?? 'child error');
        events[index]!.push(event.type);
        waiters[index]!.get(event.type)?.();
      });
      return child;
    };
    const wait = (index: number, event: string) =>
      new Promise<void>((done, reject) => {
        if (events[index]!.includes(event)) {
          done();
          return;
        }
        const timer = setTimeout(() => {
          waiters[index]!.delete(event);
          reject(new Error(`Missing ${event}: ${errors.join('\n')}`));
        }, 15_000);
        waiters[index]!.set(event, () => {
          clearTimeout(timer);
          waiters[index]!.delete(event);
          done();
        });
      });
    const first = launch('hold');
    await wait(0, 'ready');
    first.send?.('start');
    await wait(0, 'ocr-entered');
    expect((await jobs.findById(job.id))?.status).toBe('running');
    const duplicate = await jobs.enqueue({
      organisationId: org.id,
      type: 'extract_document',
      documentId: document!.id,
    });
    // Artificially age the claim; the live OCR is still paused in the first process.
    await db.execute('UPDATE jobs SET started_at = ? WHERE id = ?', [
      new Date(Date.now() - 60_000).toISOString(),
      job.id,
    ]);
    const second = launch('recover');
    await wait(1, 'ready');
    second.send?.('start');
    await wait(1, 'finished');
    expect(events[1]).not.toContain('ocr-entered');
    expect((await jobs.findById(job.id))?.attempts).toBe(1);
    expect((await jobs.findById(job.id))?.status).toBe('running');
    expect((await jobs.findById(duplicate.id))?.status).toBe('queued');
    expect((await jobs.findById(duplicate.id))?.attempts).toBe(0);
    first.send?.('resume');
    await wait(0, 'finished');
    expect(events[0]).toContain('ocr-entered');
    expect((await jobs.findById(job.id))?.status).toBe('succeeded');
    expect(
      await db.query('SELECT id FROM extractions WHERE document_id = ?', [document!.id]),
    ).toHaveLength(1);
    expect(errors).toEqual([]);
    first.send?.('quit');
    second.send?.('quit');
  } finally {
    for (const child of children)
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    timeout = setTimeout(() => {
      for (const child of children)
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    }, 3000);
    await Promise.all(exits);
    if (timeout) clearTimeout(timeout);
    await db.close();
    await rm(directory, { recursive: true, force: true });
  }
}, 45_000);
