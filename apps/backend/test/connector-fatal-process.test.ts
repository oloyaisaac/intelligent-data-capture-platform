import { spawn } from 'node:child_process';
import { resolve } from 'node:path';

/** Characterizes an explicitly injected in-process registry; P8 is not satisfied. */
it('documents that fatal injected connector code terminates its API host process', async () => {
  const child = spawn(
    process.execPath,
    ['--import', 'tsx', 'test/fixtures/connector-fatal-process.ts'],
    {
      cwd: resolve(__dirname, '..'),
      env: { ...process.env, IDCP_TEST_DB_DRIVER: 'sqlite' },
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    },
  );
  const events: string[] = [];
  let stderr = '';
  child.stderr?.on('data', (data: Buffer) => {
    stderr += data.toString();
  });
  child.on('message', (message: unknown) => {
    if (!message || typeof message !== 'object' || !('type' in message)) return;
    const type = (message as { type: string }).type;
    events.push(type);
    if (type === 'ready') child.send?.('start');
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const exit = await Promise.race([
      new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((done, reject) => {
        child.once('error', reject);
        child.once('close', (code, signal) => done({ code, signal }));
      }),
      new Promise<never>((_done, reject) => {
        timer = setTimeout(() => reject(new Error(`Connector test timed out: ${stderr}`)), 15_000);
      }),
    ]);
    expect(events).toEqual(['ready', 'connector-entered']);
    expect(exit).toEqual({ code: 73, signal: null });
  } finally {
    if (timer) clearTimeout(timer);
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }
}, 20_000);
