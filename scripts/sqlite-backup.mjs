#!/usr/bin/env node
// Offline SQLite + filesystem backup. See docs/backup-restore.md before use.
import { createHash } from 'node:crypto';
import { createReadStream, constants } from 'node:fs';
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { DatabaseSync, backup } from 'node:sqlite';
import { pathToFileURL } from 'node:url';

const DB_FILE = 'database.sqlite';
const FILES_DIR = 'documents';
const MANIFEST = 'manifest.json';

function overlaps(a, b) {
  const inside = (parent, child) => {
    const path = relative(parent, child);
    return path === '' || (!path.startsWith(`..${sep}`) && path !== '..' && !isAbsolute(path));
  };
  return inside(a, b) || inside(b, a);
}

async function existing(path, kind) {
  const info = await lstat(path);
  if (info.isSymbolicLink() || (kind === 'directory' ? !info.isDirectory() : !info.isFile())) {
    throw new Error(`Expected a non-symlink ${kind}: ${path}`);
  }
  return realpath(path);
}

async function destination(path, protectedPaths) {
  const absolute = resolve(path);
  if (absolute === dirname(absolute)) throw new Error('Destination must not be a filesystem root.');
  const parent = await realpath(dirname(absolute));
  const result = join(parent, basename(absolute));
  if (protectedPaths.some((protectedPath) => overlaps(result, protectedPath))) {
    throw new Error('Destination overlaps an input database, storage directory, or backup.');
  }
  return result;
}

function safeKey(key) {
  return /^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(key) && !key.includes('..');
}

async function listFiles(root, sub = '') {
  const result = [];
  for (const entry of await readdir(join(root, sub), { withFileTypes: true })) {
    const key = sub ? `${sub}/${entry.name}` : entry.name;
    if (!safeKey(key)) throw new Error(`Unsafe storage path: ${key}`);
    const stat = await lstat(join(root, ...key.split('/')));
    if (stat.isSymbolicLink()) throw new Error(`Symlinks are not supported: ${key}`);
    if (stat.isDirectory()) result.push(...(await listFiles(root, key)));
    else if (stat.isFile()) result.push(key);
    else throw new Error(`Unsupported storage entry: ${key}`);
  }
  return result.sort();
}

async function hash(path) {
  const digest = createHash('sha256');
  for await (const chunk of createReadStream(path)) digest.update(chunk);
  return digest.digest('hex');
}

async function copyDocuments(source, target) {
  await mkdir(target, { mode: 0o700 });
  const keys = await listFiles(source);
  for (const key of keys) {
    const dest = join(target, ...key.split('/'));
    await mkdir(dirname(dest), { recursive: true, mode: 0o700 });
    await copyFile(join(source, ...key.split('/')), dest, constants.COPYFILE_EXCL);
    await chmod(dest, 0o600);
  }
  return keys;
}

function checkDatabase(path) {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    if (db.prepare('PRAGMA journal_mode').get().journal_mode !== 'delete') {
      throw new Error('Backup database is not in standalone rollback-journal mode.');
    }
    const rows = db.prepare('PRAGMA quick_check').all();
    if (rows.length !== 1 || rows[0].quick_check !== 'ok')
      throw new Error('SQLite quick_check failed.');
    if (
      !db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='schema_migrations'")
        .get()
    ) {
      throw new Error('Not an IDCP database: schema_migrations table is missing.');
    }
  } finally {
    db.close();
  }
}

async function manifestFor(root) {
  const files = [
    DB_FILE,
    ...(await listFiles(join(root, FILES_DIR))).map((key) => `${FILES_DIR}/${key}`),
  ];
  const hashes = {};
  for (const path of files) hashes[path] = await hash(join(root, ...path.split('/')));
  return {
    format: 'idcp-sqlite-filesystem-backup',
    version: 1,
    createdAt: new Date().toISOString(),
    files: hashes,
  };
}

export async function verifyBackup(input) {
  const root = await existing(input, 'directory');
  const entries = (await readdir(root)).sort();
  if (JSON.stringify(entries) !== JSON.stringify([DB_FILE, FILES_DIR, MANIFEST].sort())) {
    throw new Error('Backup is incomplete or contains unexpected root entries.');
  }
  await existing(join(root, DB_FILE), 'file');
  await existing(join(root, FILES_DIR), 'directory');
  await existing(join(root, MANIFEST), 'file');
  const data = JSON.parse(await readFile(join(root, MANIFEST), 'utf8'));
  if (
    data?.format !== 'idcp-sqlite-filesystem-backup' ||
    data.version !== 1 ||
    typeof data.createdAt !== 'string' ||
    !data.files ||
    typeof data.files !== 'object' ||
    Array.isArray(data.files)
  ) {
    throw new Error('Invalid backup manifest.');
  }
  const actual = await manifestFor(root);
  const expectedKeys = Object.keys(data.files).sort();
  const actualKeys = Object.keys(actual.files).sort();
  if (
    JSON.stringify(expectedKeys) !== JSON.stringify(actualKeys) ||
    actualKeys.some((key) => data.files[key] !== actual.files[key])
  ) {
    throw new Error('Backup files do not match the manifest.');
  }
  checkDatabase(join(root, DB_FILE));
  return { fileCount: actualKeys.length, createdAt: data.createdAt };
}

export async function createBackup({ database, storage, output }) {
  const dbPath = await existing(database, 'file');
  const storagePath = await existing(storage, 'directory');
  if (overlaps(dbPath, storagePath))
    throw new Error('Database must be outside the storage directory.');
  const target = await destination(output, [dbPath, storagePath]);
  await mkdir(target, { mode: 0o700 }); // exclusive: never overwrite an existing destination
  try {
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
      await backup(db, join(target, DB_FILE)); // includes committed WAL contents
    } finally {
      db.close();
    }
    // The backup is self-contained: leave WAL mode on the live database untouched, but
    // switch the snapshot to rollback-journal mode so it has no required sidecar files.
    const snapshot = new DatabaseSync(join(target, DB_FILE));
    try {
      snapshot.exec('PRAGMA journal_mode=DELETE');
    } finally {
      snapshot.close();
    }
    await chmod(join(target, DB_FILE), 0o600);
    checkDatabase(join(target, DB_FILE));
    await copyDocuments(storagePath, join(target, FILES_DIR));
    const manifest = await manifestFor(target);
    await writeFile(join(target, MANIFEST), `${JSON.stringify(manifest, null, 2)}\n`, {
      mode: 0o600,
      flag: 'wx',
    });
    return await verifyBackup(target);
  } catch (error) {
    await rm(target, { recursive: true, force: true });
    throw error;
  }
}

export async function restoreBackup({ input, output }) {
  const source = await existing(input, 'directory');
  const target = await destination(output, [source]);
  await verifyBackup(source);
  await mkdir(target, { mode: 0o700 });
  try {
    await copyFile(join(source, DB_FILE), join(target, DB_FILE), constants.COPYFILE_EXCL);
    await chmod(join(target, DB_FILE), 0o600);
    await copyDocuments(join(source, FILES_DIR), join(target, FILES_DIR));
    await copyFile(join(source, MANIFEST), join(target, MANIFEST), constants.COPYFILE_EXCL);
    await chmod(join(target, MANIFEST), 0o600);
    return await verifyBackup(target);
  } catch (error) {
    await rm(target, { recursive: true, force: true });
    throw error;
  }
}

async function main(args) {
  const usage =
    'Usage: node scripts/sqlite-backup.mjs create --confirm-offline --database PATH --storage PATH --output NEW_DIR | verify --input DIR | restore --confirm-offline --input DIR --output NEW_DIR';
  const [command, ...rest] = args;
  const expected =
    command === 'create'
      ? ['--confirm-offline', '--database', '--storage', '--output']
      : command === 'restore'
        ? ['--confirm-offline', '--input', '--output']
        : command === 'verify'
          ? ['--input']
          : [];
  if (!expected.length) throw new Error(usage);
  const values = {};
  for (let i = 0; i < rest.length; i++) {
    const flag = rest[i];
    if (!expected.includes(flag) || Object.hasOwn(values, flag)) throw new Error(usage);
    if (flag === '--confirm-offline') values[flag] = true;
    else {
      const value = rest[++i];
      if (!value || value.startsWith('--')) throw new Error(usage);
      values[flag] = value;
    }
  }
  if (expected.some((flag) => !Object.hasOwn(values, flag))) throw new Error(usage);
  const result =
    command === 'create'
      ? await createBackup({
          database: values['--database'],
          storage: values['--storage'],
          output: values['--output'],
        })
      : command === 'restore'
        ? await restoreBackup({ input: values['--input'], output: values['--output'] })
        : await verifyBackup(values['--input']);
  console.log(JSON.stringify({ command, ...result }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.umask(0o077);
  main(process.argv.slice(2)).catch((error) => {
    console.error(
      `Backup operation failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 1;
  });
}
