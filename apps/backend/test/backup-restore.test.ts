import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyMigrations, SqliteDatabase } from '../src/db';
import { buildApp } from '../src/http/app';
import { createLogger } from '../src/logger';
import { buildServices } from '../src/services/container';
import { FilesystemStorage } from '../src/storage';
import { FakeOcrProvider, fakePng, testConfig } from './helpers';

async function start(databasePath: string, storagePath: string) {
  const db = new SqliteDatabase({ path: databasePath });
  await applyMigrations(db);
  const services = buildServices({
    config: testConfig(),
    db,
    storage: new FilesystemStorage(storagePath),
    provider: new FakeOcrProvider(),
    logger: createLogger({ level: 'error', sink: () => undefined }),
  });
  const app = await buildApp(services);
  await app.listen({ port: 0, host: '127.0.0.1' });
  const address = app.server.address();
  if (!address || typeof address === 'string') throw new Error('No test listener');
  return {
    base: `http://127.0.0.1:${address.port}`,
    close: async () => {
      await app.close();
      await db.close();
    },
  };
}

it('restores a real SQLite database and filesystem for login and document download', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'idcp-app-restore-'));
  let app: Awaited<ReturnType<typeof start>> | undefined;
  try {
    const database = join(dir, 'live.sqlite');
    const storage = join(dir, 'storage');
    await mkdir(storage);
    app = await start(database, storage);
    const password = 'correct horse battery staple';
    const email = 'restore-test@example.com';
    const registered = await fetch(`${app.base}/api/v1/auth/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        email,
        password,
        displayName: 'Test User',
        organisationName: 'Test Ltd',
        acceptTerms: true,
      }),
    });
    expect(registered.status).toBe(201);
    const { accessToken } = (await registered.json()) as { accessToken: string };
    const content = fakePng('restore test');
    const form = new FormData();
    form.append(
      'file',
      new Blob([Uint8Array.from(content)], { type: 'image/png' }),
      'document.png',
    );
    const upload = await fetch(`${app.base}/api/v1/documents`, {
      method: 'POST',
      headers: { authorization: `Bearer ${accessToken}` },
      body: form,
    });
    expect(upload.status).toBe(201);
    const { id } = (await upload.json()) as { id: string };
    await app.close();
    app = undefined;

    const script = join(__dirname, '../../../scripts/sqlite-backup.mjs');
    const backup = join(dir, 'backup');
    const restored = join(dir, 'restored');
    execFileSync(process.execPath, [
      script,
      'create',
      '--confirm-offline',
      '--database',
      database,
      '--storage',
      storage,
      '--output',
      backup,
    ]);
    execFileSync(process.execPath, [
      script,
      'restore',
      '--confirm-offline',
      '--input',
      backup,
      '--output',
      restored,
    ]);
    app = await start(join(restored, 'database.sqlite'), join(restored, 'documents'));
    expect((await fetch(`${app.base}/api/v1/health`)).status).toBe(200);
    const login = await fetch(`${app.base}/api/v1/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });
    expect(login.status).toBe(200);
    const authenticated = (await login.json()) as { accessToken: string };
    const download = await fetch(`${app.base}/api/v1/documents/${id}/file`, {
      headers: { authorization: `Bearer ${authenticated.accessToken}` },
    });
    expect(download.status).toBe(200);
    expect(Buffer.from(await download.arrayBuffer())).toEqual(content);
  } finally {
    if (app) await app.close();
    await rm(dir, { recursive: true, force: true });
  }
});
