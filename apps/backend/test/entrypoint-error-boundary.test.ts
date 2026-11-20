import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { resolve } from 'node:path';

const cwd = resolve(__dirname, '..');
const secret = 'SYNTHETIC-STARTUP-SECRET';

it.each([
  ['src/index.ts', 'Failed to start IDCP API'],
  ['src/db/migrate-cli.ts', 'Migration failed'],
  ['src/db/seed-cli.ts', 'Seed failed'],
])('does not expose raw configuration errors from %s', (entry, expected) => {
  const result = spawnSync(process.execPath, ['--import', 'tsx', entry], {
    cwd,
    env: { PATH: process.env.PATH, NODE_ENV: secret },
    encoding: 'utf8',
    timeout: 15_000,
  });
  expect(result.status).toBe(1);
  expect(result.stderr).toContain(expected);
  expect(result.stderr + result.stdout).not.toContain(secret);
});

it('does not log an unhandled rejection reason in the real server process', async () => {
  const socket = createServer();
  await new Promise<void>((done) => socket.listen(0, '127.0.0.1', done));
  const port = (socket.address() as { port: number }).port;
  await new Promise<void>((done, reject) =>
    socket.close((error) => (error ? reject(error) : done())),
  );
  const child = spawn(
    process.execPath,
    [
      '--require',
      './test/fixtures/emit-unhandled-rejection.cjs',
      '--import',
      'tsx',
      'src/index.ts',
    ],
    {
      cwd,
      env: {
        PATH: process.env.PATH,
        NODE_ENV: 'test',
        DB_DRIVER: 'sqlite',
        SQLITE_PATH: ':memory:',
        PORT: String(port),
        WORKER_ENABLED: 'false',
        MAINTENANCE_ENABLED: 'false',
        LOG_LEVEL: 'debug',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  let output = '';
  let timer: ReturnType<typeof setTimeout> | undefined;
  const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((done) =>
    child.once('close', (code, signal) => done({ code, signal })),
  );
  try {
    await new Promise<void>((done, reject) => {
      const collect = (chunk: Buffer) => {
        output += chunk.toString();
        if (output.includes('unhandled promise rejection')) done();
      };
      child.stdout.on('data', collect);
      child.stderr.on('data', collect);
      child.once('error', reject);
      child.once('exit', (code, signal) =>
        reject(new Error(`Server exited before rejection: ${code}/${signal} ${output}`)),
      );
      timer = setTimeout(
        () => reject(new Error(`Server did not report rejection: ${output}`)),
        15_000,
      );
    });
    expect(output).not.toContain('SYNTHETIC-REJECTION-SECRET');
    child.kill('SIGTERM');
    const exit = await closed;
    expect(exit.code).toBe(0);
    expect(output).not.toContain('SYNTHETIC-REJECTION-SECRET');
  } finally {
    if (timer) clearTimeout(timer);
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await closed;
  }
}, 30_000);
