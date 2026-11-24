// R01 synthetic connector-isolation probe (P8). Disposable host, synthetic data, no external service.
// Measures how a misbehaving connector child affects its host, using the real ConnectorProcess.
// TSX_TSCONFIG_PATH=tsconfig.base.json node --import tsx docs/reviewers/evidence/R01/connector-isolation-probe.ts
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const HOST = 'docs/reviewers/evidence/R01/fixtures/connector-isolation-host.ts';
const lines: string[] = [
  'Synthetic connector-isolation probe: disposable host using the real ConnectorProcess, adversarial child scripts, no external service.',
];
const running: Array<{ exitCode: number | null; kill: (s: NodeJS.Signals) => boolean }> = [];

type Outcome =
  | { kind: 'exited'; code: number | null; signal: NodeJS.Signals | null; ms: number }
  | { kind: 'timeout' };

/** Start the evidence host with one adversarial child script and run one invocation. */
function runCase(script: string, timeoutMs = 15_000): Promise<Outcome> {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(process.execPath, ['--import', 'tsx', HOST, script, 'run'], {
      cwd: process.cwd(),
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    });
    running.push(child);
    const stderr: string[] = [];
    child.stderr?.on('data', (chunk) => stderr.push(String(chunk)));
    let startedWork = false;
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      resolve({ kind: 'timeout' });
    }, timeoutMs);
    child.on('message', (message) => {
      const value = message as { type?: string };
      if (value.type === 'ready' && !startedWork) {
        startedWork = true;
        child.send?.('start');
      }
    });
    child.once('close', (code, signal) => {
      clearTimeout(timer);
      resolve({ kind: 'exited', code, signal, ms: Date.now() - started });
    });
    child.once('error', () => {
      clearTimeout(timer);
      resolve({ kind: 'timeout' });
    });
  });
}

function describe(outcome: Outcome): string {
  return outcome.kind === 'timeout'
    ? 'host had to be killed after the observation window'
    : `host exited code=${outcome.code} signal=${outcome.signal} after ${outcome.ms} ms`;
}

async function main(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'r01-connector-'));
  try {
    // 1. A child that signals its parent.
    const signalling = join(dir, 'signal-parent.js');
    writeFileSync(
      signalling,
      `process.stdin.resume();process.stdin.on('end',()=>{process.kill(process.ppid,'SIGTERM');process.exit(0);});`,
    );
    lines.push(`1. Child signals its host: ${describe(await runCase(signalling))}.`);

    // 2. A child that exits cleanly after spawning an unref'd descendant that writes a marker later.
    const marker = join(dir, 'grandchild-marker.txt');
    const spawner = join(dir, 'spawn-descendant.js');
    writeFileSync(
      spawner,
      `const { spawn } = require('node:child_process');
       const inner = 'setTimeout(()=>{require("node:fs").writeFileSync(' +
         JSON.stringify(marker) +
         ',"alive")},4000)';
       spawn(process.execPath, ['-e', inner], { stdio: 'ignore' }).unref();
       process.stdin.resume();
       process.stdin.on('end', () => {
         process.stdout.write(JSON.stringify({ ok: true, value: null }));
         process.exit(0);
       });`,
    );
    const spawned = await runCase(spawner);
    await new Promise((r) => setTimeout(r, 5_000));
    lines.push(
      `2. Child exits after spawning an unref'd descendant: ${describe(spawned)}; ${
        existsSync(marker)
          ? `the descendant survived and wrote its marker ("${readFileSync(marker, 'utf8')}")`
          : 'the descendant did not survive'
      }.`,
    );

    // 3. A child that writes a file outside its own directory (same OS identity as the host).
    const outside = join(dir, 'outside-child-write.txt');
    const writer = join(dir, 'write-outside.js');
    writeFileSync(
      writer,
      `require('node:fs').writeFileSync(${JSON.stringify(outside)}, 'child wrote this');
       process.stdin.resume();
       process.stdin.on('end', () => {
         process.stdout.write(JSON.stringify({ ok: true, value: null }));
         process.exit(0);
       });`,
    );
    const wrote = await runCase(writer);
    lines.push(
      `3. Child writes outside its own directory: ${describe(wrote)}; ${
        existsSync(outside)
          ? `the file was created ("${readFileSync(outside, 'utf8')}")`
          : 'no file was created'
      }.`,
    );

    // 4. A child that holds the pipe open past the transport timeout.
    const slow = join(dir, 'hold-open.js');
    writeFileSync(slow, `process.stdin.resume();setInterval(()=>{},1000);`);
    lines.push(`4. Child never answers (transport timeout 3 s): ${describe(await runCase(slow))}.`);

    // 5. A child that emits far more than the 4 KiB output cap.
    const flood = join(dir, 'flood.js');
    writeFileSync(
      flood,
      `process.stdin.resume();process.stdin.on('end',()=>{process.stdout.write('x'.repeat(1024*1024));});`,
    );
    lines.push(`5. Child emits 1 MiB against a 4 KiB cap: ${describe(await runCase(flood))}.`);

    process.stdout.write(`${lines.join('\n')}\n`);
  } finally {
    for (const child of running) {
      if (child.exitCode === null) child.kill('SIGKILL');
    }
    rmSync(dir, { recursive: true, force: true });
  }
}

main().catch((error: unknown) => {
  process.stdout.write(`${lines.join('\n')}\n`);
  process.stderr.write(`Probe failed: ${String(error)}\n`);
  process.exitCode = 1;
});
