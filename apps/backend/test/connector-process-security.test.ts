import { spawn } from 'node:child_process';
import { resolve } from 'node:path';

/** This deliberately proves the subprocess is NOT a security sandbox or P8 guarantee. */
it('shows a same-privilege child can signal its disposable API host', async () => {
  const child = spawn(
    process.execPath,
    ['--import', 'tsx', 'test/fixtures/connector-process-host-victim.ts'],
    {
      cwd: resolve(__dirname, '..'),
      env: { ...process.env, IDCP_TEST_DB_DRIVER: 'sqlite' },
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    },
  );
  let ready = false;
  child.on('message', (message: unknown) => {
    if (message && typeof message === 'object' && 'type' in message && message.type === 'ready') {
      ready = true;
      child.send?.('start');
    }
  });
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await Promise.race([
      new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((done, reject) => {
        child.once('error', reject);
        child.once('close', (code, signal) => done({ code, signal }));
      }),
      new Promise<never>((_done, reject) => {
        timeout = setTimeout(() => reject(new Error('Fixture timed out')), 15_000);
      }),
    ]);
    expect(ready).toBe(true);
    expect(result).toEqual({ code: null, signal: 'SIGTERM' });
  } finally {
    if (timeout) clearTimeout(timeout);
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }
}, 20_000);
