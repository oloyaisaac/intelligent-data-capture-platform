import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { SqliteDatabase } from '../src/db/sqlite';
import { applyMigrations } from '../src/db/migrations';
import { OrganisationsRepository } from '../src/repositories/auth-repo';
import { buildServices } from '../src/services/container';
import { FilesystemStorage } from '../src/storage';
import { silentLogger } from '../src/logger';
import { FakeOcrProvider, testConfig } from './helpers';

it('retains the reserved key after a killed export writer without age-based cleanup', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'idcp-export-crash-'));
  const path = join(directory, 'db.sqlite');
  const storageDirectory = join(directory, 'storage');
  const db = new SqliteDatabase({ path });
  let child: ChildProcess | undefined;
  let closed: Promise<{ code: number | null; signal: NodeJS.Signals | null }> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await applyMigrations(db);
    const organisation = await new OrganisationsRepository(db).create({
      name: 'Export crash',
      slug: 'export-crash',
    });
    child = spawn(
      process.execPath,
      [
        '--import',
        'tsx',
        'test/fixtures/export-crash-process.ts',
        path,
        storageDirectory,
        organisation.id,
      ],
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
        const event = message as { type: string };
        if (event.type === 'stored') done();
        if (event.type === 'error' || event.type === 'unexpected-completion')
          reject(new Error(event.type));
      });
      child!.once('error', reject);
      child!.once('exit', (code, signal) =>
        reject(new Error(`child exited before barrier: ${code}/${signal} ${stderr}`)),
      );
      timer = setTimeout(() => reject(new Error(`child did not reach barrier: ${stderr}`)), 15_000);
    });
    await barrier;
    if (timer) clearTimeout(timer);
    expect(child.kill('SIGKILL')).toBe(true);
    expect(await closed).toEqual({ code: null, signal: 'SIGKILL' });
    const row = await db.one<{
      status: string;
      storage_key: string | null;
      expires_at: string | null;
    }>('SELECT status, storage_key, expires_at FROM exports WHERE organisation_id = ?', [
      organisation.id,
    ]);
    expect(row).toMatchObject({ status: 'queued', expires_at: null });
    expect(row?.storage_key).toBeTruthy();
    const storage = new FilesystemStorage(storageDirectory);
    expect(await storage.exists(row!.storage_key!)).toBe(true);
    const services = buildServices({
      db,
      storage,
      provider: new FakeOcrProvider(),
      config: testConfig(),
      logger: silentLogger,
    });
    expect(
      (await services.maintenance.runOnce(new Date('2999-01-01T00:00:00.000Z'))).exportsExpired,
    ).toBe(0);
    expect(await storage.exists(row!.storage_key!)).toBe(true);
  } finally {
    if (timer) clearTimeout(timer);
    if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    if (closed) await closed;
    await db.close();
    await rm(directory, { recursive: true, force: true });
  }
}, 30_000);
