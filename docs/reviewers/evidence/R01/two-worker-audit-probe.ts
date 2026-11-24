/**
 * R01 ARC-AC-17 probe: two real backend processes against one SQLite file, measuring the checklist's
 * literal criteria — no double-processing, no crash, no duplicate audit rows.
 *
 * mode `clean` (default): both processes run workers, drain 12 uploads.
 * mode `crash`: only one process runs a worker; it is SIGKILLed *while holding a claim*, then a fresh
 *   process is started on the same database to see whether the interrupted work is redone or lost.
 *
 * OCR is a fake local binary (TESSERACT_BIN); no external service or real document is involved.
 * TSX_TSCONFIG_PATH=tsconfig.base.json node --import tsx docs/reviewers/evidence/R01/two-worker-audit-probe.ts [crash]
 */
import { spawn } from 'node:child_process';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const DOCUMENTS = 12;
const MODE: 'clean' | 'crash' = process.argv[2] === 'crash' ? 'crash' : 'clean';
const ports = [4400, 4401, 4402] as const;
const lines: string[] = [
  `Synthetic two-worker probe (mode=${MODE}): real backend processes, one SQLite file, fake OCR binary.`,
];

function writeFakeOcr(dir: string): string {
  const binary = join(dir, 'fake-tesseract.sh');
  const counter = join(dir, 'ocr-invocations');
  writeFileSync(counter, '0');
  writeFileSync(
    binary,
    `#!/bin/sh
count=$(cat ${counter} 2>/dev/null || echo 0)
count=$((count + 1))
echo "$count" > ${counter}
# A brief pause widens the window in which a claim is held while OCR runs.
sleep 1
printf 'level\\tpage_num\\tblock_num\\tpar_num\\tline_num\\tword_num\\tleft\\ttop\\twidth\\theight\\tconf\\ttext\\n'
printf '5\\t1\\t1\\t1\\t1\\t1\\t0\\t0\\t10\\t10\\t95\\tInvoice-%s\\n' "$count"
printf '5\\t1\\t1\\t1\\t1\\t2\\t20\\t0\\t10\\t10\\t95\\tTotal-100\\n'
`,
  );
  chmodSync(binary, 0o755);
  return binary;
}

function startProcess(port: number, dbPath: string, binary: string, worker: boolean) {
  const child = spawn(process.execPath, ['--import', 'tsx', 'apps/backend/src/index.ts'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      PORT: String(port),
      HOST: '127.0.0.1',
      SQLITE_PATH: dbPath,
      STORAGE_ROOT: join(dbPath, '..', 'storage'),
      WORKER_ENABLED: worker ? 'true' : 'false',
      AI_PROVIDER: 'local',
      TESSERACT_BIN: binary,
      RATE_LIMIT_ENABLED: 'false',
      LOG_LEVEL: 'error',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const log: string[] = [];
  child.stdout?.on('data', (chunk) => log.push(String(chunk)));
  child.stderr?.on('data', (chunk) => log.push(String(chunk)));
  return { child, log, port, worker };
}

/** A process is alive only when it has neither exited nor been killed by a signal. */
function isAlive(entry: { child: { exitCode: number | null; signalCode: NodeJS.Signals | null } }) {
  return entry.child.exitCode === null && entry.child.signalCode === null;
}

async function waitForHealth(port: number, timeoutMs = 90_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if ((await fetch(`http://127.0.0.1:${port}/api/v1/health`)).ok) return;
    } catch {
      // not listening yet
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`process on ${port} never became healthy`);
}

async function register(port: number, email: string): Promise<string> {
  const response = await fetch(`http://127.0.0.1:${port}/api/v1/auth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      email,
      password: 'Synthetic-TwoWorker-Passw0rd',
      displayName: 'Two worker probe',
      organisationName: 'Two worker probe org',
      acceptTerms: true,
    }),
  });
  const body = (await response.json()) as { accessToken?: string };
  if (!body.accessToken) throw new Error(`registration failed HTTP ${response.status}`);
  return body.accessToken;
}

async function upload(port: number, token: string, index: number): Promise<number> {
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==',
    'base64',
  );
  const form = new FormData();
  form.append('file', new Blob([png], { type: 'image/png' }), `probe-${index}.png`);
  const response = await fetch(`http://127.0.0.1:${port}/api/v1/documents`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}` },
    body: form,
  });
  return response.status;
}

async function readJobs(dbPath: string) {
  const { SqliteDatabase } = await import(resolve('apps/backend/src/db/sqlite.ts'));
  const db = new SqliteDatabase({ path: dbPath });
  try {
    const running = await db.one<{ n: number }>(
      "SELECT COUNT(*) AS n FROM jobs WHERE status = 'running'",
    );
    const total = await db.one<{ n: number }>('SELECT COUNT(*) AS n FROM jobs');
    return { running: running?.n ?? 0, total: total?.n ?? 0 };
  } finally {
    await db.close();
  }
}

async function settle(port: number, token: string, timeoutMs = 150_000) {
  const deadline = Date.now() + timeoutMs;
  let settled = 0;
  let seen = '';
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 1500));
    const listed = (await fetch(`http://127.0.0.1:${port}/api/v1/documents?limit=100`, {
      headers: { authorization: `Bearer ${token}` },
    }).then((r) => r.json())) as { items?: Array<{ status: string }> };
    const items = listed.items ?? [];
    settled = items.filter((d) =>
      ['extracted', 'needs_review', 'approved'].includes(d.status),
    ).length;
    seen = [...new Set(items.map((d) => d.status))].join(', ');
  }
  return { settled, seen };
}

async function inspect(dbPath: string) {
  const { SqliteDatabase } = await import(resolve('apps/backend/src/db/sqlite.ts'));
  const db = new SqliteDatabase({ path: dbPath });
  try {
    const dupAudit = await db.query<{ action: string; target_id: string; n: number }>(
      `SELECT action, target_id, COUNT(*) AS n FROM audit_logs
       GROUP BY action, target_id HAVING COUNT(*) > 1`,
    );
    const dupJobs = await db.query<{ document_id: string; n: number; statuses: string }>(
      `SELECT document_id, COUNT(*) AS n, GROUP_CONCAT(status) AS statuses FROM jobs
       GROUP BY document_id HAVING COUNT(*) > 1`,
    );
    const totals = await db.one<{ jobs: number; audit: number; running: number; queued: number }>(
      `SELECT (SELECT COUNT(*) FROM jobs) AS jobs,
              (SELECT COUNT(*) FROM audit_logs) AS audit,
              (SELECT COUNT(*) FROM jobs WHERE status = 'running') AS running,
              (SELECT COUNT(*) FROM jobs WHERE status = 'queued') AS queued`,
    );
    return { dupAudit, dupJobs, totals };
  } finally {
    await db.close();
  }
}

async function main(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'r01-two-worker-'));
  const dbPath = join(dir, 'workers.sqlite');
  const binary = writeFakeOcr(dir);
  const running: Array<ReturnType<typeof startProcess>> = [];
  try {
    if (MODE === 'clean') {
      const a = startProcess(ports[0], dbPath, binary, true);
      const b = startProcess(ports[1], dbPath, binary, true);
      running.push(a, b);
      await Promise.all([waitForHealth(ports[0]), waitForHealth(ports[1])]);
      lines.push(`Both processes healthy with WORKER_ENABLED=true on one SQLite file.`);

      const token = await register(ports[0], `two-worker-${Date.now()}@example.test`);
      const codes: number[] = [];
      for (let i = 0; i < DOCUMENTS; i += 1) codes.push(await upload(ports[i % 2], token, i));
      lines.push(
        `${DOCUMENTS} uploads alternated: ${codes.filter((c) => c === 201).length} created (HTTP ${[...new Set(codes)].join(',')}).`,
      );

      const { settled, seen } = await settle(ports[0], token);
      const result = await inspect(dbPath);
      lines.push(`Documents post-extraction: ${settled}/${DOCUMENTS} (statuses seen: ${seen}).`);
      lines.push(
        `Duplicate audit rows: ${result.dupAudit.length === 0 ? 'none' : JSON.stringify(result.dupAudit)}.`,
      );
      lines.push(
        `Documents with more than one job: ${result.dupJobs.length === 0 ? 'none' : JSON.stringify(result.dupJobs)}.`,
      );
      lines.push(
        `Job rows ${result.totals?.jobs}, audit rows ${result.totals?.audit}, still running ${result.totals?.running}, still queued ${result.totals?.queued}.`,
      );
      lines.push(`Processes still alive: ${running.filter(isAlive).length}/2.`);
    } else {
      // Phase 1: a single worker claims and starts OCR.
      const owner = startProcess(ports[0], dbPath, binary, true);
      running.push(owner);
      await waitForHealth(ports[0]);
      const token = await register(ports[0], `crash-${Date.now()}@example.test`);
      for (let i = 0; i < DOCUMENTS; i += 1) await upload(ports[0], token, i);

      // Wait until the worker actually holds a claim, then kill it without shutdown handling.
      let sawRunning = 0;
      const claimDeadline = Date.now() + 60_000;
      while (Date.now() < claimDeadline) {
        const state = await readJobs(dbPath);
        sawRunning = Math.max(sawRunning, state.running);
        if (state.running > 0) break;
        await new Promise((r) => setTimeout(r, 200));
      }
      owner.child.kill('SIGKILL');
      await new Promise((r) => setTimeout(r, 500));
      const afterKill = await readJobs(dbPath);
      lines.push(
        `CRASH: killed the only worker while holding a claim (observed ${sawRunning} running). After SIGKILL: ${afterKill.running} job(s) still 'running' of ${afterKill.total}.`,
      );

      // Phase 2: a fresh process on the same database, as an operator restart would do.
      const survivor = startProcess(ports[1], dbPath, binary, true);
      running.push(survivor);
      await waitForHealth(ports[1]);
      const { settled, seen } = await settle(ports[1], token);
      const result = await inspect(dbPath);
      lines.push(
        `After restart: ${settled}/${DOCUMENTS} documents post-extraction (statuses seen: ${seen}).`,
      );
      lines.push(
        `Duplicate audit rows: ${result.dupAudit.length === 0 ? 'none' : JSON.stringify(result.dupAudit)}.`,
      );
      lines.push(
        `Documents with more than one job: ${result.dupJobs.length === 0 ? 'none' : JSON.stringify(result.dupJobs)}.`,
      );
      lines.push(
        `Job rows ${result.totals?.jobs}, audit rows ${result.totals?.audit}, still running ${result.totals?.running}, still queued ${result.totals?.queued}.`,
      );
    }
    process.stdout.write(`${lines.join('\n')}\n`);
  } finally {
    for (const entry of running) if (isAlive(entry)) entry.child.kill('SIGKILL');
    rmSync(dir, { recursive: true, force: true });
  }
}

void main().catch((error: unknown) => {
  process.stdout.write(`${lines.join('\n')}\n`);
  process.stderr.write(`Probe failed: ${String(error)}\n`);
  process.exitCode = 1;
});
