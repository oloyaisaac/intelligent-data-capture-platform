import { constants } from 'node:fs';
import { lstat, mkdir, open, rm, writeFile } from 'node:fs/promises';
import { join, normalize, resolve, sep } from 'node:path';
import { AppError } from '@idcp/shared';

/**
 * Object storage abstraction (DEC-010).
 * Keys are always generated server-side; user input never becomes part of a path.
 */

export interface Storage {
  readonly driver: 'filesystem' | 'memory';
  /** Create a new key exclusively; never overwrite an existing file or object. */
  put(key: string, data: Buffer, contentType?: string): Promise<void>;
  get(key: string): Promise<Buffer>;
  /** Idempotent: deleting an already-missing key must succeed, to support cleanup retries. */
  delete(key: string): Promise<void>;
  exists(key: string): Promise<boolean>;
}

/** The adapter did not create the requested key because an object already existed. */
export class StorageKeyExistsError extends Error {
  constructor() {
    // Do not include the key: paths may contain sensitive identifiers.
    super('Storage key already exists.');
    this.name = 'StorageKeyExistsError';
  }
}

const SAFE_KEY = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;

export function assertSafeKey(key: string): string {
  const normalised = normalize(key).replace(/^([.]{2}[/\\])+/, '');
  if (
    !SAFE_KEY.test(key) ||
    key.includes('..') ||
    key.startsWith('/') ||
    normalised.split(/[/\\]/).includes('..')
  ) {
    throw new AppError('INTERNAL_ERROR', 'Invalid storage key.');
  }
  return key;
}

/** Builds a namespaced, non-guessable key: `org/<orgId>/documents/<uuid>.<ext>`. */
export function buildStorageKey(parts: {
  organisationId: string;
  kind: 'documents' | 'exports' | 'pages';
  id: string;
  extension: string;
}): string {
  const safeExtension = parts.extension.replace(/[^a-z0-9]/gi, '').slice(0, 8) || 'bin';
  return `org/${parts.organisationId}/${parts.kind}/${parts.id}.${safeExtension}`;
}

export class FilesystemStorage implements Storage {
  readonly driver = 'filesystem' as const;

  private readonly root: string;

  constructor(root: string) {
    // Remove trailing separators so lstat does not accidentally follow a symlinked root.
    this.root = resolve(root);
  }

  private components(key: string): string[] {
    assertSafeKey(key);
    return normalize(key).split(sep).filter(Boolean);
  }

  private resolve(key: string): string {
    return join(this.root, ...this.components(key));
  }

  private async checkDirectory(path: string, create: boolean, recursive = false): Promise<void> {
    if (create) {
      try {
        await mkdir(path, { recursive });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      }
    }
    const entry = await lstat(path);
    if (!entry.isDirectory() || entry.isSymbolicLink()) {
      throw new Error('Storage path is not a safe directory.');
    }
  }

  private async checkParents(key: string, create: boolean): Promise<string> {
    const parts = this.components(key);
    // Root creation preserves first-run behavior. It cannot verify a missing or wrong mount.
    await this.checkDirectory(this.root, create, true);
    let parent = this.root;
    for (const part of parts.slice(0, -1)) {
      parent = join(parent, part);
      await this.checkDirectory(parent, create);
    }
    return join(parent, parts[parts.length - 1]!);
  }

  async put(key: string, data: Buffer): Promise<void> {
    const path = await this.checkParents(key, true);
    try {
      // O_EXCL claims the final path atomically and refuses an existing symlink or file.
      await writeFile(path, data, { mode: 0o600, flag: 'wx' });
    } catch (error) {
      if (error && typeof error === 'object' && (error as NodeJS.ErrnoException).code === 'EEXIST')
        throw new StorageKeyExistsError();
      throw error;
    }
  }

  async get(key: string): Promise<Buffer> {
    try {
      const path = await this.checkParents(key, false);
      const entry = await lstat(path);
      if (!entry.isFile() || entry.isSymbolicLink() || entry.nlink !== 1) {
        throw new Error('Storage entry is not a safe file.');
      }
      // Where supported, do not follow a final symlink substituted after lstat; nonblocking open
      // avoids hanging on a substituted FIFO. Parents and mount identity still are not fenced.
      const handle = await open(
        path,
        constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0),
      );
      try {
        const opened = await handle.stat();
        if (!opened.isFile() || opened.nlink !== 1) {
          throw new Error('Storage entry is not a safe file.');
        }
        return await handle.readFile();
      } finally {
        await handle.close();
      }
    } catch {
      throw new AppError('NOT_FOUND', 'File not found.');
    }
  }

  async delete(key: string): Promise<void> {
    const path = this.resolve(key);
    // Do not treat an absent or invalid root as proof that the object was deleted. Check each
    // component without following symlinks, and refuse hard-linked or non-regular final files.
    // These checks are advisory: replacement between lstat and rm, root ancestors and mounts
    // still require a trusted, stable storage tree and a stronger OS-level deletion protocol.
    const root = await lstat(this.root);
    if (!root.isDirectory() || root.isSymbolicLink()) {
      throw new Error('Storage root is not a safe directory.');
    }
    const parts = key.split('/').filter((part) => part !== sep && part !== '');
    let current = this.root;
    for (let index = 0; index < parts.length; index += 1) {
      current = join(current, parts[index]!);
      let entry;
      try {
        entry = await lstat(current);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
        throw error;
      }
      const final = index === parts.length - 1;
      if (
        entry.isSymbolicLink() ||
        (final ? !entry.isFile() || entry.nlink !== 1 : !entry.isDirectory())
      ) {
        throw new Error('Storage path cannot be safely deleted.');
      }
    }
    await rm(path, { force: true });
  }

  async exists(key: string): Promise<boolean> {
    try {
      const path = await this.checkParents(key, false);
      const entry = await lstat(path);
      return entry.isFile() && !entry.isSymbolicLink() && entry.nlink === 1;
    } catch {
      return false;
    }
  }
}

export class MemoryStorage implements Storage {
  readonly driver = 'memory' as const;
  private readonly objects = new Map<string, Buffer>();

  async put(key: string, data: Buffer): Promise<void> {
    assertSafeKey(key);
    if (this.objects.has(key)) throw new StorageKeyExistsError();
    this.objects.set(key, Buffer.from(data));
  }

  async get(key: string): Promise<Buffer> {
    const value = this.objects.get(key);
    if (!value) throw new AppError('NOT_FOUND', 'File not found.');
    return value;
  }

  async delete(key: string): Promise<void> {
    this.objects.delete(key);
  }

  async exists(key: string): Promise<boolean> {
    return this.objects.has(key);
  }

  /** Test helper: total stored bytes. */
  size(): number {
    let total = 0;
    for (const value of this.objects.values()) total += value.length;
    return total;
  }
}

/**
 * Content sniffing: never trust `Content-Type` from the client (SECURITY.md §7).
 * Returns the detected MIME type, or null when the content is not an allowed type.
 */
export function sniffMimeType(buffer: Buffer): string | null {
  if (buffer.length < 4) return null;

  if (buffer.length >= 3 && buffer.subarray(0, 3).toString('hex') === 'ffd8ff') return 'image/jpeg';
  if (buffer.length >= 8 && buffer.subarray(0, 8).toString('hex') === '89504e470d0a1a0a') {
    return 'image/png';
  }
  if (buffer.length >= 5 && buffer.subarray(0, 5).toString('latin1') === '%PDF-') {
    return 'application/pdf';
  }
  // HEIC/HEIF: ISO base media file format with an ftyp box.
  if (buffer.length >= 12 && buffer.subarray(4, 8).toString('latin1') === 'ftyp') {
    const brand = buffer.subarray(8, 12).toString('latin1');
    if (['heic', 'heix', 'hevc', 'mif1', 'msf1'].includes(brand)) return 'image/heic';
  }
  return null;
}

export function extensionForMimeType(mimeType: string): string {
  switch (mimeType) {
    case 'image/jpeg':
      return 'jpg';
    case 'image/png':
      return 'png';
    case 'image/heic':
      return 'heic';
    case 'application/pdf':
      return 'pdf';
    case 'text/csv':
      return 'csv';
    case 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet':
      return 'xlsx';
    default:
      return 'bin';
  }
}
