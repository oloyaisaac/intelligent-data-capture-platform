import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { SqliteDatabase } from '../src/db/sqlite';
import { applyMigrations } from '../src/db/migrations';
import { OrganisationsRepository } from '../src/repositories/auth-repo';
import { DocumentsRepository } from '../src/repositories/document-repo';
import { JobsRepository } from '../src/repositories/system-repo';
import { WorkerRecoveryRepository } from '../src/repositories/worker-recovery-repo';
import { buildServices } from '../src/services/container';
import { MemoryStorage } from '../src/storage';
import { silentLogger } from '../src/logger';
import type { OcrProvider } from '../src/ai/providers/types';
import { testConfig } from './helpers';

it('keeps the reservation after SIGKILL during remote OCR and blocks retry at the limit', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'idcp-remote-crash-'));
  const path = join(directory, 'db.sqlite');
  const db = new SqliteDatabase({ path });
  let child: ChildProcess | undefined;
  let closed: Promise<{ code: number | null; signal: NodeJS.Signals | null }> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await applyMigrations(db);
    const org = await new OrganisationsRepository(db).create({
      name: 'Crash',
      slug: 'remote-crash',
    });
    const document = await new DocumentsRepository(db).createIfAbsent({
      organisationId: org.id,
      storageKey: 'synthetic-image',
      mimeType: 'image/png',
      sizeBytes: 9,
      sha256: 'synthetic',
      status: 'queued',
    });
    if (!document) throw new Error('Document creation failed');
    const jobs = new JobsRepository(db);
    const job = await jobs.enqueue({
      organisationId: org.id,
      type: 'extract_document',
      documentId: document.id,
    });
    child = spawn(
      process.execPath,
      ['--import', 'tsx', 'test/fixtures/remote-ocr-crash-process.ts', path],
      { cwd: resolve(__dirname, '..'), stdio: ['ignore', 'ignore', 'pipe', 'ipc'] },
    );
    let stderr = '';
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    closed = new Promise((done) => child!.once('close', (code, signal) => done({ code, signal })));
    await new Promise<void>((done, reject) => {
      child!.on('message', (message: unknown) => {
        if (!message || typeof message !== 'object' || !('type' in message)) return;
        const event = message as { type: string };
        if (event.type === 'ready') child!.send?.('start');
        if (event.type === 'provider-entered') done();
        if (event.type === 'error' || event.type === 'unexpected-completion')
          reject(new Error(event.type));
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
    if (timer) clearTimeout(timer);
    expect(child.kill('SIGKILL')).toBe(true);
    expect(await closed).toEqual({ code: null, signal: 'SIGKILL' });
    expect(
      await db.one('SELECT remote_ocr_invocations FROM documents WHERE id = ?', [document.id]),
    ).toEqual({ remote_ocr_invocations: 1 });
    expect((await jobs.findById(job.id))?.status).toBe('running');
    expect(
      await new WorkerRecoveryRepository(db).requeueWithAudit({
        id: job.id,
        attempt: 1,
        operatorReference: 'operator-test',
        incidentReference: 'INC-42',
      }),
    ).toBe(true);
    const storage = new MemoryStorage();
    await storage.put('synthetic-image', Buffer.from('synthetic'));
    const ocr = jest.fn();
    const provider: OcrProvider = { name: 'synthetic-remote', isLocal: false, ocr };
    const worker = buildServices({
      db,
      storage,
      provider,
      config: testConfig({ AI_MAX_REMOTE_CALLS_PER_DOC: '1' }),
      logger: silentLogger,
    }).worker;
    await worker.drain();
    expect(ocr).not.toHaveBeenCalled();
    expect(
      await db.one('SELECT remote_ocr_invocations FROM documents WHERE id = ?', [document.id]),
    ).toEqual({ remote_ocr_invocations: 1 });
    expect((await jobs.findById(job.id))?.status).toBe('queued');
  } finally {
    if (timer) clearTimeout(timer);
    if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    if (closed) await closed;
    await db.close();
    await rm(directory, { recursive: true, force: true });
  }
}, 30_000);
