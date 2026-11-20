import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

it('does not overwrite a key when independent processes race to create it', async () => {
  const root = await mkdtemp(join(tmpdir(), 'idcp-exclusive-process-'));
  const children: ChildProcess[] = [];
  const closes: Array<Promise<void>> = [];
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const key = 'org/a/documents/file.png';
    const results = new Promise<string[]>((done, reject) => {
      const ready = new Set<number>();
      const outcomes: string[] = [];
      for (const value of ['writer-one', 'writer-two']) {
        const child = spawn(
          process.execPath,
          ['--import', 'tsx', 'test/fixtures/storage-exclusive-process.ts', root, key, value],
          { cwd: resolve(__dirname, '..'), stdio: ['ignore', 'ignore', 'pipe', 'ipc'] },
        );
        children.push(child);
        let stderr = '';
        child.stderr?.on('data', (chunk: Buffer) => {
          stderr += chunk.toString();
        });
        closes.push(new Promise((finish) => child.once('close', () => finish())));
        child.once('error', reject);
        child.once('exit', (code, signal) => {
          if (outcomes.length < 2)
            reject(new Error(`child exited early ${code}/${signal}: ${stderr}`));
        });
        child.on('message', (message: unknown) => {
          if (!message || typeof message !== 'object' || !('type' in message)) return;
          const event = message as { type: string };
          if (event.type === 'ready') {
            ready.add(child.pid!);
            if (ready.size === 2) for (const process of children) process.send?.('write');
          } else if (event.type === 'written' || event.type === 'collision') {
            outcomes.push(`${value}:${event.type}`);
            if (outcomes.length === 2) done(outcomes);
          } else reject(new Error('Unexpected child response'));
        });
      }
      timer = setTimeout(() => reject(new Error('Timed out waiting for filesystem race')), 15_000);
    });
    const outcomes = await results;
    if (timer) clearTimeout(timer);
    const winner = outcomes.find((entry) => entry.endsWith(':written'));
    expect(winner).toBeDefined();
    expect(outcomes.filter((entry) => entry.endsWith(':written'))).toHaveLength(1);
    expect(outcomes.filter((entry) => entry.endsWith(':collision'))).toHaveLength(1);
    expect((await readFile(join(root, key))).toString()).toBe(winner!.split(':')[0]);
  } finally {
    if (timer) clearTimeout(timer);
    for (const child of children)
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await Promise.all(closes);
    await rm(root, { recursive: true, force: true });
  }
}, 30_000);
