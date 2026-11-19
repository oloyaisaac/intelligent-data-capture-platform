import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { SqliteDatabase } from '../src/db/sqlite';
import { applyMigrations } from '../src/db/migrations';
import { OrganisationsRepository } from '../src/repositories/auth-repo';
import { DocumentPagesRepository, DocumentsRepository } from '../src/repositories/document-repo';
import { JobsRepository } from '../src/repositories/system-repo';
import { buildServices } from '../src/services/container';
import { MemoryStorage } from '../src/storage';
import { silentLogger } from '../src/logger';
import { FakeOcrProvider, testConfig } from './helpers';

/** Crash inside the real SQLite publication transaction, with a deterministic in-process OCR fake. */
it('rolls back publication on SIGKILL and requires explicit recovery before retry', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'idcp-worker-crash-'));
  const path = join(directory, 'db.sqlite');
  const db = new SqliteDatabase({ path });
  let child: ChildProcess | undefined;
  let closed: Promise<{ code: number | null; signal: NodeJS.Signals | null }> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await applyMigrations(db);
    const organisation = await new OrganisationsRepository(db).create({
      name: 'Crash test',
      slug: 'crash-test',
    });
    const document = await new DocumentsRepository(db).createIfAbsent({
      organisationId: organisation.id,
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
      organisationId: organisation.id,
      type: 'extract_document',
      documentId: document!.id,
    });

    child = spawn(
      process.execPath,
      ['--import', 'tsx', 'test/fixtures/worker-crash-process.ts', path],
      {
        cwd: resolve(__dirname, '..'),
        stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
      },
    );
    let stderr = '';
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    closed = new Promise((done) => child!.once('close', (code, signal) => done({ code, signal })));
    const barrier = new Promise<void>((done, reject) => {
      child!.on('message', (message: unknown) => {
        if (!message || typeof message !== 'object' || !('type' in message)) return;
        const event = message as { type: string; message?: string };
        if (event.type === 'ready') child!.send?.('start');
        if (event.type === 'inside-publication') done();
        if (event.type === 'error' || event.type === 'unexpected-completion')
          reject(new Error(event.message ?? event.type));
      });
      child!.once('error', reject);
      child!.once('exit', (code, signal) =>
        reject(new Error(`worker exited before barrier: ${code}/${signal} ${stderr}`)),
      );
      timer = setTimeout(
        () => reject(new Error(`worker did not reach barrier: ${stderr}`)),
        15_000,
      );
    });
    await barrier;
    if (timer) clearTimeout(timer);
    expect(child.kill('SIGKILL')).toBe(true);
    expect(await closed).toEqual({ code: null, signal: 'SIGKILL' });

    const interrupted = await jobs.findById(job.id);
    expect(interrupted?.status).toBe('running');
    expect(interrupted?.attempts).toBe(1);
    expect(
      await db.query('SELECT id FROM extractions WHERE document_id = ?', [document!.id]),
    ).toHaveLength(0);
    const page = await db.one<{ ocr_text: string | null }>(
      'SELECT ocr_text FROM document_pages WHERE document_id = ?',
      [document!.id],
    );
    expect(page?.ocr_text).toBeNull();
    const before = await db.one<{ status: string }>('SELECT status FROM documents WHERE id = ?', [
      document!.id,
    ]);
    expect(before?.status).toBe('processing');

    const storage = new MemoryStorage();
    await storage.put('synthetic-image', Buffer.from('synthetic'));
    const provider = new FakeOcrProvider();
    provider.setText('INVOICE\nInvoice No: CRASH-1\nTotal: UGX 100');
    const services = buildServices({
      db,
      storage,
      provider,
      config: testConfig(),
      logger: silentLogger,
    });
    await services.worker.start();
    await services.worker.stop();
    // A crashed claim stays running at startup; age does not prove the process is dead.
    expect((await jobs.findById(job.id))?.status).toBe('running');
    await db.execute('UPDATE jobs SET started_at = ? WHERE id = ?', [
      new Date(Date.now() - 60_000).toISOString(),
      job.id,
    ]);
    await services.worker.start();
    await services.worker.stop();
    expect((await jobs.findById(job.id))?.status).toBe('running');
    // The killed process is gone; a real operator must also review possible external effects.
    expect(await jobs.requeueInterrupted(job.id, 1)).toBe(true);
    await services.worker.drain();
    expect((await jobs.findById(job.id))?.status).toBe('succeeded');
    expect(
      await db.query('SELECT id FROM extractions WHERE document_id = ?', [document!.id]),
    ).toHaveLength(1);
    expect(provider.calls).toBe(1);
  } finally {
    if (timer) clearTimeout(timer);
    if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    if (closed) await closed;
    await db.close();
    await rm(directory, { recursive: true, force: true });
  }
}, 30_000);
