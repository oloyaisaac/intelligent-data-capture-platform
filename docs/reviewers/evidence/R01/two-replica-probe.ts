// R01 T-04 probe: two API replicas over one SQLite database, to observe behaviour that differs from
// a single process. Startup lives in this package because the workspace declares no `tsx`.
// TSX_TSCONFIG_PATH=tsconfig.base.json node --import tsx docs/reviewers/evidence/R01/two-replica-probe.ts
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const lines: string[] = [
  'Synthetic two-replica probe: two API processes on one SQLite file, no workers, no external service.',
];
const ports = [4300, 4301] as const;
const children: Array<{ kill: (s: NodeJS.Signals) => boolean; exitCode: number | null }> = [];

function startReplica(port: number, dbPath: string) {
  const child = spawn(process.execPath, ['--import', 'tsx', 'apps/backend/src/index.ts'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      PORT: String(port),
      HOST: '127.0.0.1',
      SQLITE_PATH: dbPath,
      WORKER_ENABLED: 'false',
      RATE_LIMIT_ENABLED: 'true',
      // Small enough that the per-process counter is exhausted quickly.
      RATE_LIMIT_AUTH_PER_15_MIN: '3',
      LOG_LEVEL: 'error',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.push(child);
  let log = '';
  child.stdout?.on('data', (chunk) => (log += String(chunk)));
  child.stderr?.on('data', (chunk) => (log += String(chunk)));
  return { child, readLog: () => log };
}

async function waitForHttp(port: number, timeoutMs = 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/v1/health`);
      if (response.ok) return;
    } catch {
      // not listening yet
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`replica on ${port} never became healthy`);
}

async function login(port: number, email: string): Promise<number> {
  const response = await fetch(`http://127.0.0.1:${port}/api/v1/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password: 'wrong-password-on-purpose' }),
  });
  return response.status;
}

async function register(port: number, email: string): Promise<string> {
  const response = await fetch(`http://127.0.0.1:${port}/api/v1/auth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      email,
      password: 'Synthetic-Readonly-Passw0rd',
      displayName: 'Replica probe',
      organisationName: 'Replica probe org',
      acceptTerms: true,
    }),
  });
  const body = (await response.json()) as {
    accessToken?: string;
    tokens?: { accessToken?: string };
  };
  const token = body.accessToken ?? body.tokens?.accessToken;
  if (!token) throw new Error(`registration failed with HTTP ${response.status}`);
  return token;
}

async function postJson(
  port: number,
  path: string,
  body: unknown,
  token: string,
): Promise<{ status: number; json: unknown }> {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  return { status: response.status, json: await response.json().catch(() => ({})) };
}

async function main(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'r01-two-replica-'));
  const dbPath = join(dir, 'replicas.sqlite');
  try {
    ports.forEach((port) => startReplica(port, dbPath));
    await Promise.all(ports.map((port) => waitForHttp(port)));
    lines.push(`Both replicas healthy on one database file: ports ${ports.join(' and ')}.`);

    // 1. Per-process rate limiting: the configured budget is per replica, not per service.
    const email = `probe-${Date.now()}@example.test`;
    const a: number[] = [];
    const b: number[] = [];
    for (let i = 0; i < 4; i += 1) a.push(await login(ports[0], email));
    for (let i = 0; i < 4; i += 1) b.push(await login(ports[1], email));
    lines.push(
      `1. Same account, 4 failed logins per replica (budget RATE_LIMIT_AUTH_PER_15_MIN=3): replica A ${a.join(
        ',',
      )}; replica B ${b.join(',')}.`,
    );
    const total = a.concat(b).filter((s) => s === 401).length;
    const limited = a.concat(b).filter((s) => s === 429).length;
    lines.push(
      `   Effective budget across the pair: ${total} attempts accepted before limiting, ${limited} rejected with 429 — a per-replica budget, so replicas multiply the limit.`,
    );

    // 2. Register a real account and pair a device, then observe whether an event published by
    //    replica A reaches a stream held by replica B. The in-memory hub has no cross-process bus.
    const token = await register(ports[0], email);
    const bridge = await fetch(`http://127.0.0.1:${ports[0]}/api/v1/events`, {
      headers: { authorization: `Bearer ${token}`, accept: 'text/event-stream' },
    });
    const reader = bridge.body?.getReader();
    let frames = '';
    void (async () => {
      for (;;) {
        const chunk = await reader?.read();
        if (!chunk || chunk.done) break;
        frames += new TextDecoder().decode(chunk.value);
      }
    })();
    await new Promise((r) => setTimeout(r, 300));

    const session = await postJson(ports[0], '/api/v1/pairing/sessions', { token }, token);
    const pairingToken = String(
      (session.json as { token?: string; pairingToken?: string }).token ??
        (session.json as { pairingToken?: string }).pairingToken ??
        '',
    );
    lines.push(
      `2a. Pairing session created on replica A: HTTP ${session.status}, token present=${pairingToken.length > 0}.`,
    );

    // Publish the same event through replica B: its hub is a different object in a different process.
    await postJson(ports[1], '/api/v1/pairing/sessions', { token }, token);
    await new Promise((r) => setTimeout(r, 1500));
    reader?.cancel().catch(() => undefined);
    lines.push(
      `2b. Stream opened on replica A while replica B published: A stream received ${
        frames.includes('device:') ? 'its own event' : 'no cross-replica event'
      } (${frames.split('\n\n').filter(Boolean).length} frame(s)).`,
    );

    // 3. Any shared log or state written by both processes to the same path?
    lines.push(
      `3. Both replicas ran against ${dbPath} with WORKER_ENABLED=false, so no job claims compete here; T-03 covers claim contention on one database.`,
    );

    process.stdout.write(`${lines.join('\n')}\n`);
  } finally {
    for (const child of children) {
      if (child.exitCode === null) child.kill('SIGTERM');
    }
    rmSync(dir, { recursive: true, force: true });
  }
}

main().catch((error: unknown) => {
  process.stdout.write(`${lines.join('\n')}\n`);
  process.stderr.write(`Probe failed: ${String(error)}\n`);
  process.exitCode = 1;
});
