import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { SqliteDatabase } from '../src/db/sqlite';
import { applyMigrations } from '../src/db/migrations';

const delay = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));

async function availablePort(): Promise<number> {
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

/** Happy-path R01 T-03 exercise; deliberately does not model stale-job recovery or crashes. */
it('processes twenty uploaded documents once with two API/worker subprocesses', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'idcp-two-workers-'));
  const path = join(directory, 'db.sqlite');
  const trace = join(directory, 'ocr-pids.txt');
  const fakeOcr = join(directory, 'fake-tesseract');
  const db = new SqliteDatabase({ path });
  const children: ChildProcess[] = [];
  const exits: Promise<void>[] = [];
  let logs = '';
  try {
    await applyMigrations(db);
    // Tesseract is unavailable in the sandbox. A short, deterministic executable emits TSV and
    // records which API/worker process invoked it. This tests the worker path, not OCR quality.
    await writeFile(
      fakeOcr,
      `#!/bin/sh
printf '%s\\n' "$PPID" >> "$IDCP_TEST_OCR_TRACE"
sleep 0.2
printf 'level\\tpage_num\\tblock_num\\tpar_num\\tline_num\\tword_num\\tleft\\ttop\\twidth\\theight\\tconf\\ttext\\n5\\t1\\t1\\t1\\t1\\t1\\t0\\t0\\t10\\t10\\t95\\tInvoice\\n'
`,
    );
    await chmod(fakeOcr, 0o700);
    const portA = await availablePort();
    let portB = await availablePort();
    for (let retry = 0; portA === portB && retry < 10; retry += 1) portB = await availablePort();
    if (portA === portB) throw new Error('Could not allocate distinct test ports');
    const bases = [portA, portB].map((port) => `http://127.0.0.1:${port}/api/v1`);
    for (const port of [portA, portB]) {
      const child = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts'], {
        cwd: resolve(__dirname, '..'),
        stdio: ['ignore', 'pipe', 'pipe'],
        env: {
          ...process.env,
          NODE_ENV: 'development',
          DB_DRIVER: 'sqlite',
          SQLITE_PATH: path,
          STORAGE_DRIVER: 'filesystem',
          STORAGE_PATH: join(directory, 'storage'),
          PORT: String(port),
          JWT_SECRET: 'synthetic-worker-test-secret-at-least-32',
          ENCRYPTION_KEY: 'synthetic-worker-test-encryption-key',
          WORKER_ENABLED: 'true',
          WORKER_POLL_INTERVAL_MS: '50',
          MAINTENANCE_ENABLED: 'false',
          RATE_LIMIT_ENABLED: 'false',
          AI_PROVIDER: 'local',
          TESSERACT_BIN: fakeOcr,
          IDCP_TEST_OCR_TRACE: trace,
          LOG_LEVEL: 'error',
        },
      });
      children.push(child);
      exits.push(new Promise<void>((done) => child.once('close', () => done())));
      child.stdout?.on('data', (data: Buffer) => {
        logs += data.toString();
      });
      child.stderr?.on('data', (data: Buffer) => {
        logs += data.toString();
      });
    }
    for (const base of bases) {
      let ready = false;
      const deadline = Date.now() + 15_000;
      while (!ready && Date.now() < deadline) {
        if (children.some((child) => child.exitCode !== null))
          throw new Error(`Worker exited early: ${logs}`);
        try {
          ready = (await fetch(`${base}/health`, { signal: AbortSignal.timeout(1000) })).ok;
        } catch {
          /* starting */
        }
        if (!ready) await delay(50);
      }
      if (!ready) throw new Error(`Worker did not start: ${logs}`);
    }
    const register = await fetch(`${bases[0]}/auth/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        email: 'workers@example.com',
        password: 'correct horse battery staple',
        displayName: 'Worker Test',
        organisationName: 'Worker Test',
        acceptTerms: true,
      }),
    });
    expect(register.status).toBe(201);
    const account = (await register.json()) as {
      accessToken: string;
      user: { organisationId: string };
    };
    const ids: string[] = [];
    for (let i = 0; i < 20; i += 1) {
      const form = new FormData();
      form.append(
        'file',
        new Blob([Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex')], { type: 'image/png' }),
        `synthetic-${i}.png`,
      );
      const response = await fetch(`${bases[0]}/documents`, {
        method: 'POST',
        headers: { authorization: `Bearer ${account.accessToken}` },
        body: form,
      });
      if (response.status !== 201)
        throw new Error(`Upload ${i} failed: ${response.status} ${await response.text()}`);
      const body = (await response.json()) as { id: string };
      ids.push(body.id);
    }
    const deadline = Date.now() + 40_000;
    let rows: Array<{ document_id: string; status: string; attempts: number }> = [];
    while (Date.now() < deadline) {
      if (children.some((child) => child.exitCode !== null))
        throw new Error(`Worker exited: ${logs}`);
      rows = await db.query(
        'SELECT document_id, status, attempts FROM jobs WHERE organisation_id = ?',
        [account.user.organisationId],
      );
      if (rows.length === 20 && rows.every((row) => row.status === 'succeeded')) break;
      await delay(100);
    }
    expect(rows).toHaveLength(20);
    expect(rows.every((row) => row.status === 'succeeded' && Number(row.attempts) === 1)).toBe(
      true,
    );
    expect(new Set(rows.map((row) => row.document_id))).toEqual(new Set(ids));
    const extractions = await db.query<{ document_id: string; count: number }>(
      'SELECT document_id, COUNT(*) AS count FROM extractions WHERE organisation_id = ? GROUP BY document_id',
      [account.user.organisationId],
    );
    expect(extractions).toHaveLength(20);
    expect(extractions.every((row) => Number(row.count) === 1)).toBe(true);
    const audits = await db.query<{ target_id: string; count: number }>(
      "SELECT target_id, COUNT(*) AS count FROM audit_logs WHERE organisation_id = ? AND action = 'document.uploaded' GROUP BY target_id",
      [account.user.organisationId],
    );
    expect(audits).toHaveLength(20);
    expect(audits.every((row) => Number(row.count) === 1)).toBe(true);
    const invocations = (await readFile(trace, 'utf8')).trim().split('\n');
    expect(invocations).toHaveLength(20);
    expect(new Set(invocations)).toEqual(new Set(children.map((child) => String(child.pid))));
  } finally {
    for (const child of children)
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    const force = setTimeout(() => {
      for (const child of children)
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    }, 3000);
    await Promise.all(exits);
    clearTimeout(force);
    await db.close();
    await rm(directory, { recursive: true, force: true });
  }
}, 75_000);
