import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { SqliteDatabase } from '../src/db/sqlite';
import { applyMigrations } from '../src/db/migrations';

const delay = (ms: number) => new Promise<void>((resolveDelay) => setTimeout(resolveDelay, ms));

async function freePort(): Promise<number> {
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

async function waitFor(predicate: () => boolean, description: string): Promise<void> {
  const deadline = Date.now() + 12_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${description}`);
    await delay(25);
  }
}

/** Actual API subprocesses, with workers disabled. This characterises replicas; it does not make them safe. */
it('observes shared sessions but separate limiters and SSE across two API replicas', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'idcp-replicas-'));
  const path = join(directory, 'data.sqlite');
  const database = new SqliteDatabase({ path });
  const children: ChildProcess[] = [];
  const exits: Promise<void>[] = [];
  const controllers: AbortController[] = [];
  let logs = '';
  try {
    await applyMigrations(database);
    await database.close();
    const firstPort = await freePort();
    let secondPort = await freePort();
    for (let retry = 0; secondPort === firstPort && retry < 10; retry += 1) {
      secondPort = await freePort();
    }
    if (firstPort === secondPort) throw new Error('Could not allocate distinct replica ports');
    const ports = [firstPort, secondPort];
    for (const port of ports) {
      const child = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts'], {
        cwd: resolve(__dirname, '..'),
        stdio: ['ignore', 'pipe', 'pipe'],
        env: {
          ...process.env,
          // Test mode defaults to per-process MemoryStorage, not the shared filesystem adapter.
          NODE_ENV: 'development',
          DB_DRIVER: 'sqlite',
          SQLITE_PATH: path,
          STORAGE_DRIVER: 'filesystem',
          STORAGE_PATH: join(directory, 'storage'),
          PORT: String(port),
          JWT_SECRET: 'synthetic-replica-test-secret-at-least-32',
          ENCRYPTION_KEY: 'synthetic-replica-test-encryption-key',
          WORKER_ENABLED: 'false',
          MAINTENANCE_ENABLED: 'false',
          RATE_LIMIT_ENABLED: 'true',
          RATE_LIMIT_AUTH_PER_15_MIN: '2',
          TRUST_PROXY: 'false',
          LOG_LEVEL: 'error',
        },
      });
      children.push(child);
      exits.push(new Promise<void>((resolveExit) => child.once('close', () => resolveExit())));
      child.stdout?.on('data', (data: Buffer) => {
        logs += data.toString();
      });
      child.stderr?.on('data', (data: Buffer) => {
        logs += data.toString();
      });
    }
    const bases = ports.map((port) => `http://127.0.0.1:${port}/api/v1`);
    for (const base of bases) {
      let ready = false;
      const deadline = Date.now() + 15_000;
      while (!ready && Date.now() < deadline) {
        if (children.some((child) => child.exitCode !== null))
          throw new Error(`Replica exited: ${logs}`);
        try {
          ready = (await fetch(`${base}/health`, { signal: AbortSignal.timeout(1000) })).ok;
        } catch {
          /* starting */
        }
        if (!ready) await delay(50);
      }
      if (!ready) throw new Error(`Replica did not start: ${logs}`);
    }
    const request = (base: string, route: string, body: unknown) =>
      fetch(`${base}${route}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
    const email = 'replica@example.com';
    const password = 'correct horse battery staple';
    const registered = await request(bases[0]!, '/auth/register', {
      email,
      password,
      displayName: 'Replica test',
      organisationName: 'Replica test',
      acceptTerms: true,
    });
    expect(registered.status).toBe(201);
    const login = await request(bases[1]!, '/auth/login', { email, password });
    expect(login.status).toBe(200);
    const { accessToken } = (await login.json()) as { accessToken: string };
    expect(
      (await fetch(`${bases[0]}/auth/me`, { headers: { authorization: `Bearer ${accessToken}` } }))
        .status,
    ).toBe(200);

    const streams: Array<{ text: string }> = [];
    for (const base of bases) {
      const controller = new AbortController();
      controllers.push(controller);
      const response = await fetch(`${base}/events`, {
        headers: { authorization: `Bearer ${accessToken}` },
        signal: controller.signal,
      });
      expect(response.status).toBe(200);
      if (!response.body) throw new Error('Missing SSE body');
      const state = { text: '' };
      streams.push(state);
      const reader = response.body.getReader();
      void (async () => {
        const decoder = new TextDecoder();
        try {
          for (;;) {
            const chunk = await reader.read();
            if (chunk.done) break;
            state.text += decoder.decode(chunk.value, { stream: true });
          }
        } catch {
          /* aborted during cleanup */
        }
      })();
    }
    await Promise.all(
      streams.map((stream) => waitFor(() => stream.text.includes('"connected"'), 'SSE connection')),
    );
    async function upload(base: string, marker: string) {
      const form = new FormData();
      form.append(
        'file',
        new Blob([Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex')], { type: 'image/png' }),
        `${marker}.png`,
      );
      const response = await fetch(`${base}/documents`, {
        method: 'POST',
        headers: { authorization: `Bearer ${accessToken}` },
        body: form,
      });
      expect(response.status).toBe(201);
      return (await response.json()) as { id: string };
    }
    const first = await upload(bases[0]!, 'first');
    await waitFor(() => streams[0]!.text.includes(first.id), 'local A upload event');
    const second = await upload(bases[1]!, 'second');
    await waitFor(() => streams[1]!.text.includes(second.id), 'local B upload event');
    await delay(300);
    expect(streams[1]!.text).not.toContain(first.id);
    expect(streams[0]!.text).not.toContain(second.id);
    expect(
      (
        await fetch(`${bases[1]}/documents/${first.id}`, {
          headers: { authorization: `Bearer ${accessToken}` },
        })
      ).status,
    ).toBe(200);
    const file = await fetch(`${bases[1]}/documents/${first.id}/file`, {
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(file.status).toBe(200);
    expect(Buffer.from(await file.arrayBuffer())).toEqual(
      Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex'),
    );

    const wrong = { email, password: 'wrong password' };
    expect((await request(bases[0]!, '/auth/login', wrong)).status).toBe(401);
    expect((await request(bases[0]!, '/auth/login', wrong)).status).toBe(401);
    expect((await request(bases[0]!, '/auth/login', wrong)).status).toBe(429);
    expect((await request(bases[1]!, '/auth/login', wrong)).status).toBe(401);
  } finally {
    for (const controller of controllers) controller.abort();
    for (const child of children)
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    const force = setTimeout(() => {
      for (const child of children)
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    }, 3000);
    await Promise.all(exits);
    clearTimeout(force);
    await database.close().catch(() => undefined);
    await rm(directory, { recursive: true, force: true });
  }
}, 45_000);
