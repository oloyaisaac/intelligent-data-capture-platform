import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { SqliteDatabase } from '../src/db/sqlite';
import { applyMigrations } from '../src/db/migrations';

const delay = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));

async function portForTest(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') return reject(new Error('No test port'));
      server.close((error) => (error ? reject(error) : resolvePort(address.port)));
    });
  });
}

/** A real API/worker and a controlled fake OCR process, not a crash-recovery test. */
it('waits for an active extraction to commit before a SIGTERM shutdown exits', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'idcp-shutdown-'));
  const database = new SqliteDatabase({ path: join(directory, 'db.sqlite') });
  const started = join(directory, 'ocr-started');
  const release = join(directory, 'ocr-release');
  const executable = join(directory, 'fake-tesseract');
  let child: ChildProcess | undefined;
  let closed: Promise<{ code: number | null; signal: NodeJS.Signals | null }> | undefined;
  let logs = '';
  try {
    await applyMigrations(database);
    await writeFile(
      executable,
      `#!/bin/sh
printf 'started' > "$IDCP_OCR_STARTED"
while [ ! -f "$IDCP_OCR_RELEASE" ]; do sleep 0.05; done
printf 'level\\tpage_num\\tblock_num\\tpar_num\\tline_num\\tword_num\\tleft\\ttop\\twidth\\theight\\tconf\\ttext\\n5\\t1\\t1\\t1\\t1\\t1\\t0\\t0\\t10\\t10\\t95\\tInvoice\\n'
`,
    );
    await chmod(executable, 0o700);
    const port = await portForTest();
    const base = `http://127.0.0.1:${port}/api/v1`;
    child = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts'], {
      cwd: resolve(__dirname, '..'),
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        NODE_ENV: 'development',
        DB_DRIVER: 'sqlite',
        SQLITE_PATH: join(directory, 'db.sqlite'),
        STORAGE_DRIVER: 'filesystem',
        STORAGE_PATH: join(directory, 'storage'),
        PORT: String(port),
        JWT_SECRET: 'synthetic-shutdown-test-secret-at-least-32',
        ENCRYPTION_KEY: 'synthetic-shutdown-test-encryption-key',
        WORKER_ENABLED: 'true',
        WORKER_POLL_INTERVAL_MS: '50',
        MAINTENANCE_ENABLED: 'false',
        RATE_LIMIT_ENABLED: 'false',
        AI_PROVIDER: 'local',
        TESSERACT_BIN: executable,
        IDCP_OCR_STARTED: started,
        IDCP_OCR_RELEASE: release,
        LOG_LEVEL: 'error',
      },
    });
    closed = new Promise((done) => child!.once('close', (code, signal) => done({ code, signal })));
    child.stdout?.on('data', (data: Buffer) => {
      logs += data.toString();
    });
    child.stderr?.on('data', (data: Buffer) => {
      logs += data.toString();
    });
    let ready = false;
    const readyDeadline = Date.now() + 15_000;
    while (!ready && Date.now() < readyDeadline) {
      if (child.exitCode !== null) throw new Error(`API exited early: ${logs}`);
      try {
        ready = (await fetch(`${base}/health`, { signal: AbortSignal.timeout(1000) })).ok;
      } catch {
        /* starting */
      }
      if (!ready) await delay(50);
    }
    if (!ready) throw new Error(`API did not start: ${logs}`);
    const registration = await fetch(`${base}/auth/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        email: 'shutdown@example.com',
        password: 'correct horse battery staple',
        displayName: 'Test',
        organisationName: 'Shutdown Test',
        acceptTerms: true,
      }),
    });
    expect(registration.status).toBe(201);
    const { accessToken } = (await registration.json()) as { accessToken: string };
    const form = new FormData();
    form.append(
      'file',
      new Blob([Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex')], { type: 'image/png' }),
      'invoice.png',
    );
    const upload = await fetch(`${base}/documents`, {
      method: 'POST',
      headers: { authorization: `Bearer ${accessToken}` },
      body: form,
    });
    expect(upload.status).toBe(201);
    const { id } = (await upload.json()) as { id: string };
    let ocrStarted = false;
    const ocrDeadline = Date.now() + 15_000;
    while (!ocrStarted && Date.now() < ocrDeadline) {
      if (child.exitCode !== null) throw new Error(`API exited during OCR: ${logs}`);
      try {
        ocrStarted = (await readFile(started, 'utf8')) === 'started';
      } catch {
        /* pending */
      }
      if (!ocrStarted) await delay(50);
    }
    if (!ocrStarted) throw new Error(`OCR did not start: ${logs}`);
    expect(child.kill('SIGTERM')).toBe(true);
    await delay(250);
    expect(child.exitCode).toBeNull();
    expect(child.signalCode).toBeNull();
    await writeFile(release, 'continue');
    const timeout = setTimeout(() => child?.kill('SIGKILL'), 10_000);
    const result = await closed;
    clearTimeout(timeout);
    expect(result).toEqual({ code: 0, signal: null });
    const job = await database.one<{ status: string }>(
      'SELECT status FROM jobs WHERE document_id = ?',
      [id],
    );
    expect(job?.status).toBe('succeeded');
    const extraction = await database.one<{ count: number }>(
      'SELECT COUNT(*) AS count FROM extractions WHERE document_id = ?',
      [id],
    );
    expect(Number(extraction?.count)).toBe(1);
  } finally {
    await writeFile(release, 'continue').catch(() => undefined);
    if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    const force = setTimeout(() => child?.kill('SIGKILL'), 3000);
    if (closed) await closed;
    clearTimeout(force);
    await database.close();
    await rm(directory, { recursive: true, force: true });
  }
}, 45_000);
