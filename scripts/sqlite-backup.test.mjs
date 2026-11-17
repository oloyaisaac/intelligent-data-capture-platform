import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createBackup, restoreBackup, verifyBackup } from './sqlite-backup.mjs';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'idcp-backup-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const database = join(root, 'live.sqlite');
  const storage = join(root, 'storage');
  await mkdir(join(storage, 'org', '1', 'documents'), { recursive: true });
  await writeFile(join(storage, 'org', '1', 'documents', 'page.png'), 'synthetic document');
  const db = new DatabaseSync(database);
  db.exec(
    "PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE schema_migrations (id TEXT); INSERT INTO schema_migrations VALUES ('test'); CREATE TABLE sample (value TEXT); INSERT INTO sample VALUES ('committed WAL data');",
  );
  t.after(() => {
    try {
      db.close();
    } catch {}
  });
  return { root, database, storage, db };
}

test('backup and restore SQLite WAL data and nested documents without overwriting', async (t) => {
  const { root, database, storage, db } = await fixture(t);
  const output = join(root, 'backup');
  // Deliberately leave a connection open to exercise the SQLite backup API's handling of WAL.
  // Real operators must stop every writer for a coordinated database/filesystem snapshot.
  const report = await createBackup({ database, storage, output });
  assert.equal(report.fileCount, 2);
  db.close();
  assert.equal((await verifyBackup(output)).fileCount, 2);
  const restored = join(root, 'restored');
  await restoreBackup({ input: output, output: restored });
  const copy = new DatabaseSync(join(restored, 'database.sqlite'), { readOnly: true });
  try {
    assert.equal(copy.prepare('SELECT value FROM sample').get().value, 'committed WAL data');
  } finally {
    copy.close();
  }
  assert.equal(
    await readFile(join(restored, 'documents/org/1/documents/page.png'), 'utf8'),
    'synthetic document',
  );
  assert.equal((await stat(output)).mode & 0o777, 0o700);
  assert.equal((await stat(join(output, 'database.sqlite'))).mode & 0o777, 0o600);
  await assert.rejects(createBackup({ database, storage, output }));
  await assert.rejects(restoreBackup({ input: output, output: restored }));
});

test('rejects corruption, missing and unexpected files without publishing a restore', async (t) => {
  const { root, database, storage, db } = await fixture(t);
  db.close();
  const output = join(root, 'backup');
  await createBackup({ database, storage, output });
  const file = join(output, 'documents/org/1/documents/page.png');
  await writeFile(file, 'tampered');
  await assert.rejects(verifyBackup(output), /manifest/);
  const restored = join(root, 'restored');
  await assert.rejects(restoreBackup({ input: output, output: restored }), /manifest/);
  await assert.rejects(stat(restored), { code: 'ENOENT' });
  await writeFile(file, 'synthetic document');
  await writeFile(join(output, 'unexpected'), 'x');
  await assert.rejects(verifyBackup(output), /unexpected/);
  await rm(join(output, 'unexpected'));
  await rm(file);
  await assert.rejects(verifyBackup(output), /manifest/);
});

test('rejects symlinks, unsafe paths, overlapping destinations and non-IDCP databases', async (t) => {
  const { root, database, storage, db } = await fixture(t);
  db.close();
  await assert.rejects(
    createBackup({ database, storage, output: join(storage, 'backup') }),
    /overlaps/,
  );
  await symlink(database, join(storage, 'link'));
  const output = join(root, 'backup');
  await assert.rejects(createBackup({ database, storage, output }), /Symlinks/);
  await assert.rejects(stat(output), { code: 'ENOENT' });
  await rm(join(storage, 'link'));
  await writeFile(join(storage, 'bad..name'), 'x');
  await assert.rejects(createBackup({ database, storage, output }), /Unsafe/);
  await rm(join(storage, 'bad..name'));
  const other = join(root, 'other.sqlite');
  const unrelated = new DatabaseSync(other);
  unrelated.exec('CREATE TABLE other (id INTEGER)');
  unrelated.close();
  await assert.rejects(createBackup({ database: other, storage, output }), /Not an IDCP database/);
  await assert.rejects(stat(output), { code: 'ENOENT' });
});

test('CLI requires explicit offline confirmation and can verify a complete backup', async (t) => {
  const { root, database, storage, db } = await fixture(t);
  db.close();
  const script = resolve('scripts/sqlite-backup.mjs');
  const output = join(root, 'backup');
  const args = [script, 'create', '--database', database, '--storage', storage, '--output', output];
  assert.notEqual(spawnSync(process.execPath, args).status, 0);
  assert.notEqual(
    spawnSync(process.execPath, [...args, '--confirm-offline', '--confirm-offline']).status,
    0,
  );
  execFileSync(process.execPath, [...args, '--confirm-offline']);
  const report = JSON.parse(
    execFileSync(process.execPath, [script, 'verify', '--input', output], { encoding: 'utf8' }),
  );
  assert.equal(report.command, 'verify');
  assert.equal(report.fileCount, 2);
});
