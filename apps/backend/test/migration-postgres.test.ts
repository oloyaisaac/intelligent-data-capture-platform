import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { Pool } from 'pg';
import type { Database } from '../src/db/database';
import { applyMigrations } from '../src/db/migrations';
import { PostgresDatabase } from '../src/db/postgres';
import { createHarness, type Harness } from './helpers';

const pgDescribe = process.env.IDCP_TEST_DB_DRIVER === 'postgres' ? describe : describe.skip;
const migrationId = '015_workflow_approval_snapshot';
const alter = 'ALTER TABLE workflow_runs ADD COLUMN approval_snapshot TEXT';

async function within<T>(promise: Promise<T>, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), 10_000);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function intercept(
  db: Database,
  after: (db: Database, sql: string, params?: unknown[]) => Promise<void>,
): Database {
  return {
    driver: db.driver,
    query: db.query.bind(db),
    one: db.one.bind(db),
    close: db.close.bind(db),
    transaction: (fn) => db.transaction((tx) => fn(intercept(tx, after))),
    execute: async (sql, params) => {
      await db.execute(sql, params);
      await after(db, sql, params);
    },
  };
}

pgDescribe('PostgreSQL migration atomicity and locking', () => {
  let harness: Harness;
  beforeEach(async () => {
    harness = await createHarness();
    // Only this isolated test schema is modified to resemble a pre-015 database.
    await harness.db.execute('ALTER TABLE workflow_runs DROP COLUMN approval_snapshot');
    await harness.db.execute('DELETE FROM schema_migrations WHERE id = ?', [migrationId]);
  });
  afterEach(async () => {
    await harness.close();
  });

  it('rolls back DDL and its marker on failure and retries cleanly', async () => {
    const failing = intercept(harness.db, async (_db, sql, params) => {
      if (sql.startsWith('INSERT INTO schema_migrations') && params?.[0] === migrationId)
        throw new Error('synthetic marker failure');
    });
    await expect(applyMigrations(failing)).rejects.toThrow('synthetic marker failure');
    expect(
      await harness.db.one(
        "SELECT column_name FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'workflow_runs' AND column_name = 'approval_snapshot'",
      ),
    ).toBeNull();
    expect(
      await harness.db.one('SELECT id FROM schema_migrations WHERE id = ?', [migrationId]),
    ).toBeNull();
    await expect(applyMigrations(harness.db)).resolves.toEqual([migrationId]);
    await expect(applyMigrations(harness.db)).resolves.toEqual([]);
  });

  it('rolls back a migration when its PostgreSQL client process is killed', async () => {
    const row = await harness.db.one<{ schema: string }>('SELECT current_schema() AS schema');
    if (!row?.schema.match(/^idcp_test_[a-f0-9]{32}$/)) throw new Error('Unexpected test schema');
    const url = new URL(process.env.DATABASE_URL!);
    const options = url.searchParams.get('options');
    url.searchParams.set(
      'options',
      [options, `-c search_path=${row.schema}`].filter(Boolean).join(' '),
    );
    const child = spawn(
      process.execPath,
      ['--import', 'tsx', 'test/fixtures/migration-postgres-process.ts'],
      {
        cwd: resolve(__dirname, '..'),
        stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
        env: { ...process.env, IDCP_MIGRATION_TEST_DATABASE_URL: url.toString() },
      },
    );
    let stderr = '';
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((done) =>
      child.once('close', (code, signal) => done({ code, signal })),
    );
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const barrier = new Promise<void>((done, reject) => {
        child.on('message', (message: unknown) => {
          if (!message || typeof message !== 'object' || !('type' in message)) return;
          const event = message as { type: string };
          if (event.type === 'ready') child.send('start');
          if (event.type === 'inside') done();
          if (event.type === 'error' || event.type === 'unexpected-completion')
            reject(new Error(event.type));
        });
        child.once('error', reject);
        child.once('exit', (code, signal) =>
          reject(new Error(`Child exited: ${code}/${signal} ${stderr}`)),
        );
        timer = setTimeout(
          () => reject(new Error(`Migration did not reach barrier: ${stderr}`)),
          15_000,
        );
      });
      await barrier;
      if (timer) clearTimeout(timer);
      expect(child.kill('SIGKILL')).toBe(true);
      expect(await closed).toEqual({ code: null, signal: 'SIGKILL' });
      expect(
        await harness.db.one(
          "SELECT column_name FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'workflow_runs' AND column_name = 'approval_snapshot'",
        ),
      ).toBeNull();
      expect(
        await harness.db.one('SELECT id FROM schema_migrations WHERE id = ?', [migrationId]),
      ).toBeNull();
      expect(await applyMigrations(harness.db)).toEqual([migrationId]);
    } finally {
      if (timer) clearTimeout(timer);
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      await closed;
    }
  }, 30_000);

  it('reports a lost PostgreSQL transaction without an unhandled client error', async () => {
    const row = await harness.db.one<{ schema: string }>('SELECT current_schema() AS schema');
    if (!row?.schema.match(/^idcp_test_[a-f0-9]{32}$/)) throw new Error('Unexpected test schema');
    const url = new URL(process.env.DATABASE_URL!);
    url.searchParams.set(
      'options',
      [url.searchParams.get('options'), `-c search_path=${row.schema}`].filter(Boolean).join(' '),
    );
    const child = spawn(
      process.execPath,
      ['--import', 'tsx', 'test/fixtures/migration-postgres-process.ts'],
      {
        cwd: resolve(__dirname, '..'),
        stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
        env: { ...process.env, IDCP_MIGRATION_TEST_DATABASE_URL: url.toString() },
      },
    );
    const observer = new Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
    let stderr = '';
    let transactionFailed = false;
    child.on('message', (message: unknown) => {
      if (message && typeof message === 'object' && 'type' in message && message.type === 'error')
        transactionFailed = true;
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((done) =>
      child.once('close', (code, signal) => done({ code, signal })),
    );
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const barrier = new Promise<number>((done, reject) => {
        child.on('message', (message: unknown) => {
          if (!message || typeof message !== 'object' || !('type' in message)) return;
          const event = message as { type: string; pid?: number };
          if (event.type === 'ready') child.send('start');
          if (event.type === 'inside' && event.pid) done(event.pid);
          if (event.type === 'error' || event.type === 'unexpected-completion')
            reject(new Error(event.type));
        });
        child.once('error', reject);
        child.once('exit', (code, signal) =>
          reject(new Error(`Child exited early: ${code}/${signal} ${stderr}`)),
        );
        timer = setTimeout(
          () => reject(new Error(`Migration did not reach barrier: ${stderr}`)),
          15_000,
        );
      });
      const pid = await barrier;
      if (timer) clearTimeout(timer);
      const terminated = await observer.query<{ ok: boolean }>(
        'SELECT pg_terminate_backend($1) AS ok',
        [pid],
      );
      expect(terminated.rows[0]?.ok).toBe(true);
      const outcome = await Promise.race([
        closed,
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error('Child did not report the lost connection')),
            10_000,
          );
        }),
      ]);
      if (timer) clearTimeout(timer);
      expect(outcome).toEqual({ code: 0, signal: null });
      expect(transactionFailed).toBe(true);
      expect(stderr).not.toContain('Unhandled');
      expect(
        await harness.db.one('SELECT id FROM schema_migrations WHERE id = ?', [migrationId]),
      ).toBeNull();
      expect(await applyMigrations(harness.db)).toEqual([migrationId]);
    } finally {
      if (timer) clearTimeout(timer);
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      await closed;
      await observer.end();
    }
  }, 30_000);

  it('invalidates a scoped handle when a checked-out PostgreSQL connection is lost', async () => {
    const observer = new Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
    await harness.db.execute('CREATE TABLE transaction_loss_probe (value TEXT NOT NULL)');
    let reached!: (pid: number) => void;
    let release!: () => void;
    let observed!: (message: string) => void;
    const barrier = new Promise<number>((resolve) => {
      reached = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const staleResult = new Promise<string>((resolve) => {
      observed = resolve;
    });
    let transaction: Promise<void> | undefined;
    let callbackResumed = false;
    try {
      transaction = harness.db.transaction(async (tx) => {
        await tx.execute('INSERT INTO transaction_loss_probe (value) VALUES (?)', ['rolled-back']);
        const session = await tx.one<{ pid: number }>('SELECT pg_backend_pid() AS pid');
        if (!session) throw new Error('Missing PostgreSQL session');
        reached(session.pid);
        await gate;
        // Losing the connection cannot cancel arbitrary JavaScript or external side effects.
        callbackResumed = true;
        try {
          await tx.execute('INSERT INTO transaction_loss_probe (value) VALUES (?)', ['stale']);
          observed('unexpected success');
        } catch (error) {
          observed(error instanceof Error ? error.message : 'unknown');
        }
      });
      void transaction.catch(() => undefined);
      const pid = await within(barrier, 'Transaction did not reach barrier');
      expect(
        (await observer.query<{ ok: boolean }>('SELECT pg_terminate_backend($1) AS ok', [pid]))
          .rows[0]?.ok,
      ).toBe(true);
      const outcome = await within(
        transaction.then(
          () => 'resolved',
          () => 'rejected',
        ),
        'Lost transaction did not reject',
      );
      expect(outcome).toBe('rejected');
      release();
      expect(await within(staleResult, 'Stale callback did not resume')).toMatch(
        /no longer active/,
      );
      expect(callbackResumed).toBe(true);
      expect(await harness.db.query('SELECT value FROM transaction_loss_probe')).toEqual([]);
      expect(await harness.db.one('SELECT 1 AS ok')).toEqual({ ok: 1 });
    } finally {
      release();
      if (transaction) await transaction.catch(() => undefined);
      await observer.end();
    }
  }, 30_000);

  it('invalidates PostgreSQL transaction handles after commit and rollback', async () => {
    let scoped!: Database;
    await harness.db.transaction(async (tx) => {
      scoped = tx;
    });
    await expect(scoped.query('SELECT 1')).rejects.toThrow(/no longer active/);
    await expect(
      harness.db.transaction(async (tx) => {
        scoped = tx;
        throw new Error('synthetic rollback');
      }),
    ).rejects.toThrow('synthetic rollback');
    await expect(scoped.execute('SELECT 1')).rejects.toThrow(/no longer active/);
  });

  it('handles a lost idle pooled connection and can open a replacement', async () => {
    const observer = new Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
    let notified!: () => void;
    const event = new Promise<void>((resolve) => {
      notified = resolve;
    });
    const db = new PostgresDatabase({
      connectionString: process.env.DATABASE_URL!,
      poolSize: 1,
      onIdleConnectionError: notified,
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const session = await db.one<{ pid: number }>('SELECT pg_backend_pid() AS pid');
      if (!session) throw new Error('Missing PostgreSQL session');
      expect(
        (
          await observer.query<{ ok: boolean }>('SELECT pg_terminate_backend($1) AS ok', [
            session.pid,
          ])
        ).rows[0]?.ok,
      ).toBe(true);
      await Promise.race([
        event,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('No idle connection event')), 10_000);
        }),
      ]);
      expect(await db.one('SELECT 1 AS ok')).toEqual({ ok: 1 });
    } finally {
      if (timer) clearTimeout(timer);
      await db.close();
      await observer.end();
    }
  }, 30_000);

  it('serializes concurrent migrators and rereads the ledger after acquiring the PostgreSQL lock', async () => {
    const observer = new Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
    let release!: () => void;
    let reached!: (pid: number) => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const barrier = new Promise<number>((resolve) => {
      reached = resolve;
    });
    let first: Promise<string[]> | undefined;
    let second: Promise<string[]> | undefined;
    try {
      first = applyMigrations(
        intercept(harness.db, async (tx, sql) => {
          if (sql !== alter) return;
          const row = await tx.one<{ pid: number }>('SELECT pg_backend_pid() AS pid');
          if (!row) throw new Error('Missing PostgreSQL session');
          reached(row.pid);
          await gate;
        }),
      );
      void first.catch(() => undefined);
      const locker = await Promise.race([
        barrier,
        new Promise<never>((_, reject) => {
          const timer = setTimeout(
            () => reject(new Error('Migration did not reach barrier')),
            10_000,
          );
          timer.unref();
        }),
      ]);
      second = applyMigrations(harness.db);
      void second.catch(() => undefined);
      let blocked = false;
      const deadline = Date.now() + 10_000;
      while (Date.now() < deadline && !blocked) {
        const result = await observer.query<{ blocked: boolean }>(
          `SELECT EXISTS (SELECT 1 FROM pg_stat_activity a
            WHERE $1::int = ANY(pg_blocking_pids(a.pid)) AND a.wait_event_type = 'Lock'
              AND a.query LIKE 'SELECT pg_advisory_xact_lock%') AS blocked`,
          [locker],
        );
        blocked = result.rows[0]?.blocked ?? false;
        if (!blocked) await new Promise((resolve) => setTimeout(resolve, 25));
      }
      expect(blocked).toBe(true);
      release();
      expect(await first).toEqual([migrationId]);
      expect(await second).toEqual([]);
      expect(
        await harness.db.query('SELECT id FROM schema_migrations WHERE id = ?', [migrationId]),
      ).toHaveLength(1);
    } finally {
      release();
      if (first) await first.catch(() => undefined);
      if (second) await second.catch(() => undefined);
      await observer.end();
    }
  }, 30_000);
});
