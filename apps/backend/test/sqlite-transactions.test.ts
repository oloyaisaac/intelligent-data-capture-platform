import { SqliteDatabase } from '../src/db/sqlite';
import type { Database } from '../src/db/database';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe('SQLite transaction isolation on the shared connection', () => {
  let db: SqliteDatabase;
  beforeEach(async () => {
    db = new SqliteDatabase({ path: ':memory:' });
    await db.execute('CREATE TABLE entries (value TEXT NOT NULL)');
  });
  afterEach(async () => {
    await db.close();
  });

  it('waits for the transaction before an outside query and write', async () => {
    const entered = deferred();
    const release = deferred();
    const tx = db.transaction(async (scoped) => {
      await scoped.execute('INSERT INTO entries (value) VALUES (?)', ['transaction']);
      entered.resolve();
      await release.promise;
    });
    await entered.promise;
    let completed = false;
    const read = db.query<{ value: string }>('SELECT value FROM entries').then((rows) => {
      completed = true;
      return rows;
    });
    const write = db.execute('INSERT INTO entries (value) VALUES (?)', ['outside']);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(completed).toBe(false);
    release.resolve();
    await tx;
    expect(await read).toEqual([{ value: 'transaction' }]);
    await write;
    expect(await db.query('SELECT value FROM entries ORDER BY value')).toEqual([
      { value: 'outside' },
      { value: 'transaction' },
    ]);
  });

  it('does not roll back an unrelated write queued during a failing transaction', async () => {
    const entered = deferred();
    const release = deferred();
    const tx = db.transaction(async (scoped) => {
      await scoped.execute('INSERT INTO entries (value) VALUES (?)', ['rolled-back']);
      entered.resolve();
      await release.promise;
      throw new Error('abort');
    });
    const failure = expect(tx).rejects.toThrow('abort');
    await entered.promise;
    const outside = db.execute('INSERT INTO entries (value) VALUES (?)', ['retained']);
    release.resolve();
    await failure;
    await outside;
    expect(await db.query('SELECT value FROM entries')).toEqual([{ value: 'retained' }]);
  });

  it('rejects root-handle use inside a transaction rather than deadlocking', async () => {
    await db.transaction(async (scoped) => {
      await expect(db.query('SELECT value FROM entries')).rejects.toThrow(/transaction-scoped/);
      await expect(db.transaction(async () => undefined)).rejects.toThrow(/transaction-scoped/);
      await scoped.transaction(async (nested) =>
        nested.execute('INSERT INTO entries (value) VALUES (?)', ['nested']),
      );
    });
    expect(await db.query('SELECT value FROM entries')).toEqual([{ value: 'nested' }]);
  });

  it('allows later background work to use the root handle after its originating transaction ends', async () => {
    const release = deferred();
    let later!: Promise<void>;
    await db.transaction(async () => {
      later = (async () => {
        await release.promise;
        await db.execute('INSERT INTO entries (value) VALUES (?)', ['later']);
      })();
    });
    release.resolve();
    await later;
    expect(await db.query('SELECT value FROM entries')).toEqual([{ value: 'later' }]);
  });

  it('invalidates the transaction-scoped handle after commit or rollback', async () => {
    let scoped!: Database;
    await db.transaction(async (tx) => {
      scoped = tx;
    });
    await expect(scoped.query('SELECT 1')).rejects.toThrow(/no longer active/);
    await expect(
      db.transaction(async (tx) => {
        scoped = tx;
        throw new Error('abort');
      }),
    ).rejects.toThrow('abort');
    await expect(scoped.execute('DELETE FROM entries')).rejects.toThrow(/no longer active/);
  });
});
