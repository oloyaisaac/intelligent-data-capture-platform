import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, normalize, sep } from 'node:path';
import { AppError } from '@idcp/shared';

/**
 * Object storage abstraction (DEC-010).
 * Keys are always generated server-side; user input never becomes part of a path.
 */

export interface Storage {
  readonly driver: 'filesystem' | 'memory';
  put(key: string, data: Buffer, contentType?: string): Promise<void>;
  get(key: string): Promise<Buffer>;
  /** Idempotent: deleting an already-missing key must succeed, to support cleanup retries. */
  delete(key: string): Promise<void>;
  exists(key: string): Promise<boolean>;
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

  constructor(private readonly root: string) {}

  private resolve(key: string): string {
    assertSafeKey(key);
    return join(this.root, ...key.split('/').filter((part) => part !== sep && part !== ''));
  }

  async put(key: string, data: Buffer): Promise<void> {
    const path = this.resolve(key);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, data, { mode: 0o600 });
  }

  async get(key: string): Promise<Buffer> {
    try {
      return await readFile(this.resolve(key));
    } catch {
      throw new AppError('NOT_FOUND', 'File not found.');
    }
  }

  async delete(key: string): Promise<void> {
    await rm(this.resolve(key), { force: true });
  }

  async exists(key: string): Promise<boolean> {
    try {
      await stat(this.resolve(key));
      return true;
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
