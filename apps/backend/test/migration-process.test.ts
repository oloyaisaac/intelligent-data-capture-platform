import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { MIGRATIONS, applyMigrations } from '../src/db/migrations';
import { SqliteDatabase } from '../src/db/sqlite';

type Message = { type: string; applied?: string[] };
function childFor(path: string, mode: string) {
  const child = spawn(
    process.execPath,
    ['--import', 'tsx', 'test/fixtures/migration-process.ts', path, mode],
    {
      cwd: resolve(__dirname, '..'),
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    },
  );
  const events: Message[] = [];
  let stderr = '';
  child.on('message', (message: unknown) => {
    if (message && typeof message === 'object' && 'type' in message)
      events.push(message as Message);
  });
  child.stderr?.on('data', (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((done) =>
    child.once('close', (code, signal) => done({ code, signal })),
  );
  async function wait(type: string): Promise<Message> {
    const deadline = Date.now() + 12_000;
    while (Date.now() < deadline) {
      const found = events.find((event) => event.type === type);
      if (found) return found;
      if (
        events.some((event) => event.type === 'error') ||
        child.exitCode !== null ||
        child.signalCode !== null
      )
        throw new Error(`Child failed before ${type}: ${stderr}`);
      await new Promise((done) => setTimeout(done, 20));
    }
    throw new Error(`Timed out awaiting ${type}: ${stderr}`);
  }
  return { child, events, closed, wait };
}

async function prepare(path: string): Promise<void> {
  const db = new SqliteDatabase({ path });
  try {
    await db.execute(
      'CREATE TABLE schema_migrations (id TEXT PRIMARY KEY, applied_at TEXT NOT NULL)',
    );
    await db.execute('CREATE TABLE workflow_runs (id TEXT PRIMARY KEY)');
    for (const migration of MIGRATIONS.filter(
      (entry) => entry.id !== '015_workflow_approval_snapshot',
    )) {
      await db.execute('INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)', [
        migration.id,
        '2000-01-01',
      ]);
    }
  } finally {
    await db.close();
  }
}

it('rolls back a killed SQLite migration before its marker and permits recovery', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'idcp-migration-crash-'));
  const path = join(dir, 'db.sqlite');
  let child: ReturnType<typeof childFor> | undefined;
  try {
    await prepare(path);
    child = childFor(path, 'hold');
    await child.wait('ready');
    child.child.send('start');
    await child.wait('inside');
    expect(child.child.kill('SIGKILL')).toBe(true);
    expect(await child.closed).toEqual({ code: null, signal: 'SIGKILL' });
    const db = new SqliteDatabase({ path });
    try {
      expect(
        (await db.query<{ name: string }>('PRAGMA table_info(workflow_runs)')).map(
          (column) => column.name,
        ),
      ).not.toContain('approval_snapshot');
      expect(
        await db.one('SELECT id FROM schema_migrations WHERE id = ?', [
          '015_workflow_approval_snapshot',
        ]),
      ).toBeNull();
      expect(await applyMigrations(db)).toEqual(['015_workflow_approval_snapshot']);
    } finally {
      await db.close();
    }
  } finally {
    if (child && child.child.exitCode === null && child.child.signalCode === null)
      child.child.kill('SIGKILL');
    if (child) await child.closed;
    await rm(dir, { recursive: true, force: true });
  }
}, 30_000);

it('serializes two current-version SQLite migration processes on the same file', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'idcp-migration-race-'));
  const path = join(dir, 'db.sqlite');
  const children: ReturnType<typeof childFor>[] = [];
  try {
    await prepare(path);
    const first = childFor(path, 'hold');
    children.push(first);
    await first.wait('ready');
    first.child.send('start');
    await first.wait('inside');
    const second = childFor(path, 'normal');
    children.push(second);
    await second.wait('ready');
    second.child.send('start');
    await second.wait('starting');
    await new Promise((done) => setTimeout(done, 200));
    expect(second.events.some((event) => event.type === 'done')).toBe(false);
    first.child.send('release');
    expect((await first.wait('done')).applied).toEqual(['015_workflow_approval_snapshot']);
    expect((await second.wait('done')).applied).toEqual([]);
    expect(await first.closed).toEqual({ code: 0, signal: null });
    expect(await second.closed).toEqual({ code: 0, signal: null });
    const db = new SqliteDatabase({ path });
    try {
      expect(
        await db.query('SELECT id FROM schema_migrations WHERE id = ?', [
          '015_workflow_approval_snapshot',
        ]),
      ).toHaveLength(1);
      expect(
        (await db.query<{ name: string }>('PRAGMA table_info(workflow_runs)')).filter(
          (column) => column.name === 'approval_snapshot',
        ),
      ).toHaveLength(1);
    } finally {
      await db.close();
    }
  } finally {
    for (const item of children)
      if (item.child.exitCode === null && item.child.signalCode === null)
        item.child.kill('SIGKILL');
    await Promise.all(children.map((item) => item.closed));
    await rm(dir, { recursive: true, force: true });
  }
}, 30_000);
