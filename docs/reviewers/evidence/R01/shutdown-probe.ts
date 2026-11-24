// R01 synthetic lifecycle probe. Local loopback only; no external service or production data.
// Compares shutdown with no client connected against shutdown with one live SSE stream.
// TSX_TSCONFIG_PATH=tsconfig.base.json node --import tsx docs/reviewers/evidence/R01/shutdown-probe.ts
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const PORT = 4319;
const BASE = `http://127.0.0.1:${PORT}/api/v1`;
const EXIT_WINDOW_MS = 8_000;

async function waitHealthy(): Promise<number> {
  const started = Date.now();
  for (let i = 0; i < 200; i += 1) {
    try {
      const res = await fetch(`${BASE}/health`);
      if (res.ok) return Date.now() - started;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('server did not become healthy');
}

async function startServer(dir: string, maintenance = true) {
  const child = spawn(process.execPath, ['--import', 'tsx', 'apps/backend/src/index.ts'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      NODE_ENV: 'test',
      PORT: String(PORT),
      DB_DRIVER: 'sqlite',
      SQLITE_PATH: join(dir, 'idcp.db'),
      JWT_SECRET: 'test-secret-that-is-long-enough-0123456789',
      STORAGE_PATH: join(dir, 'files'),
      WORKER_ENABLED: 'false',
      MAINTENANCE_ENABLED: String(maintenance),
      MAINTENANCE_INTERVAL_MS: '60000',
      LOG_LEVEL: 'error',
      RATE_LIMIT_ENABLED: 'false',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const bootMs = await waitHealthy();
  return { child, bootMs };
}

/** SIGTERM and report whether the process exited inside the window. */
async function terminate(child: ReturnType<typeof startServer>['child']) {
  const exit = new Promise<{ code: number | null; ms: number }>((resolve) => {
    const t0 = Date.now();
    child.on('exit', (code) => resolve({ code, ms: Date.now() - t0 }));
  });
  child.kill('SIGTERM');
  const result = await Promise.race([
    exit,
    new Promise<null>((r) => setTimeout(() => r(null), EXIT_WINDOW_MS)),
  ]);
  if (!result) child.kill('SIGKILL');
  return result;
}

async function register(label: string): Promise<string> {
  const response = await fetch(`${BASE}/auth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      email: `${label}@example.test`,
      password: 'correct horse battery staple',
      displayName: 'Shutdown Probe',
      organisationName: 'Probe Ltd',
      acceptTerms: true,
    }),
  });
  assert.equal(response.status, 201, `registration failed: ${response.status}`);
  return ((await response.json()) as { accessToken: string }).accessToken;
}

const lines: string[] = [
  'Synthetic lifecycle probe: loopback HTTP, in-memory SQLite, synthetic users, no external service.',
];

async function caseIdle(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'r01-idle-'));
  const { child, bootMs } = await startServer(dir);
  try {
    const result = await terminate(child);
    assert.ok(result, 'idle server did not exit after SIGTERM');
    lines.push(
      `A. No client connected: boot ${bootMs} ms; SIGTERM -> exit code=${result.code} after ${result.ms} ms.`,
    );
  } finally {
    if (child.exitCode === null) child.kill('SIGKILL');
    rmSync(dir, { recursive: true, force: true });
  }
}

async function caseOpenStream(): Promise<{ exited: boolean; ms: number | null; client: string }> {
  const dir = mkdtempSync(join(tmpdir(), 'r01-sse-'));
  const { child, bootMs } = await startServer(dir);
  const controller = new AbortController();
  try {
    const accessToken = await register('r01-shutdown');
    const stream = await fetch(`${BASE}/events?access_token=${encodeURIComponent(accessToken)}`, {
      signal: controller.signal,
    });
    assert.equal(stream.status, 200);
    const reader = stream.body!.getReader();
    const first = await reader.read();
    assert.match(new TextDecoder().decode(first.value), /job:progress/);

    const result = await terminate(child);
    let client = 'not measured';
    try {
      const next = await reader.read();
      client = next.done ? 'client saw the stream end' : 'client still receiving frames';
    } catch (error) {
      client = `client saw a transport error (${(error as Error).name})`;
    }
    lines.push(
      `B. One authenticated SSE stream open: boot ${bootMs} ms; SIGTERM with the stream live -> ${
        result
          ? `exit code=${result.code} after ${result.ms} ms`
          : `still running after ${EXIT_WINDOW_MS} ms (killed by the probe)`
      }; ${client}.`,
    );
    controller.abort();
    return { exited: Boolean(result), ms: result?.ms ?? null, client };
  } finally {
    if (child.exitCode === null) child.kill('SIGKILL');
    controller.abort();
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Case C: same as B but with the maintenance scheduler off, to isolate the cause. */
async function caseOpenStreamNoMaintenance(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'r01-sse-nomaint-'));
  const { child } = await startServer(dir, false);
  const controller = new AbortController();
  try {
    const accessToken = await register('r01-shutdown-c');
    const stream = await fetch(`${BASE}/events?access_token=${encodeURIComponent(accessToken)}`, {
      signal: controller.signal,
    });
    assert.equal(stream.status, 200);
    await stream.body!.getReader().read();
    const result = await terminate(child);
    lines.push(
      `C. One SSE stream open, maintenance disabled: SIGTERM -> ${
        result
          ? `exit code=${result.code} after ${result.ms} ms`
          : `still running after ${EXIT_WINDOW_MS} ms (killed by the probe)`
      }.`,
    );
    controller.abort();
  } finally {
    if (child.exitCode === null) child.kill('SIGKILL');
    controller.abort();
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Case D: SIGTERM with a live stream, then the client disconnects — does shutdown then proceed? */
async function caseClientDisconnects(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'r01-sse-drop-'));
  const { child } = await startServer(dir);
  const controller = new AbortController();
  try {
    const accessToken = await register('r01-shutdown-d');
    const stream = await fetch(`${BASE}/events?access_token=${encodeURIComponent(accessToken)}`, {
      signal: controller.signal,
    });
    assert.equal(stream.status, 200);
    await stream.body!.getReader().read();

    const exit = new Promise<{ code: number | null; ms: number }>((resolve) => {
      const t0 = Date.now();
      child.on('exit', (code) => resolve({ code, ms: Date.now() - t0 }));
    });
    child.kill('SIGTERM');
    await new Promise((r) => setTimeout(r, 2_000));
    const exitedBeforeDrop = await Promise.race([
      exit,
      new Promise<null>((r) => setTimeout(() => r(null), 0)),
    ]);
    controller.abort(); // client walks away
    const result = await Promise.race([
      exit,
      new Promise<null>((r) => setTimeout(() => r(null), EXIT_WINDOW_MS)),
    ]);
    lines.push(
      `D. SIGTERM with a live stream, client disconnects 2 s later: ${
        exitedBeforeDrop
          ? 'exited before the disconnect (unexpected)'
          : 'still running at the disconnect'
      }; then ${result ? `exit code=${result.code} after ${result.ms} ms` : `no exit within ${EXIT_WINDOW_MS} ms`}.`,
    );
  } finally {
    if (child.exitCode === null) child.kill('SIGKILL');
    controller.abort();
    rmSync(dir, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  await caseIdle();
  const withStream = await caseOpenStream();
  await caseOpenStreamNoMaintenance();
  await caseClientDisconnects();
  process.stdout.write(`${lines.join('\n')}\n`);
  assert.equal(withStream.exited, false, 'expected the open SSE stream to block shutdown');
}

main().catch((error: unknown) => {
  process.stdout.write(`${lines.join('\n')}\n`);
  process.stderr.write(`Probe failed: ${String(error)}\n`);
  process.exitCode = 1;
});
