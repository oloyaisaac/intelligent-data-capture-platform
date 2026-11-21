import { lstat, opendir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type {
  StorageInventoryRepository,
  StorageReferenceKind,
} from '../repositories/storage-inventory-repo';
import { observeFile } from './export-inventory';

const PAGE_SIZE = 25;
const MAX_DIRECTORY_ENTRIES = 100_000;
export type StorageInventoryKind = 'documents' | 'exports' | 'pages';

// Current generated keys use simple components. Refuse invalid cursors and report unsupported
// directory entries rather than silently declaring the scan complete.
export function isInventoryComponent(value: string): boolean {
  return (
    typeof value === 'string' &&
    value.length <= 255 &&
    /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value) &&
    !value.includes('..')
  );
}

/**
 * A bounded, read-only inventory of one current-layout directory. Results are point-in-time only.
 * The operator must stop all writers and protect output; the tool cannot enforce either requirement.
 */
export async function listStorageInventory(
  repository: StorageInventoryRepository,
  root: string,
  organisationId: string,
  kind: StorageInventoryKind,
  after: string | null,
  options: { maxDirectoryEntries?: number } = {},
) {
  const maxEntries = options.maxDirectoryEntries ?? MAX_DIRECTORY_ENTRIES;
  if (
    !isInventoryComponent(organisationId) ||
    !['documents', 'exports', 'pages'].includes(kind) ||
    (after !== null && !isInventoryComponent(after)) ||
    !Number.isSafeInteger(maxEntries) ||
    maxEntries < 1 ||
    maxEntries > MAX_DIRECTORY_ENTRIES
  )
    throw new Error('Invalid inventory request');
  let current = resolve(root);
  const rootStat = await lstat(current);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error('Invalid storage root');
  for (const part of ['org', organisationId, kind]) {
    current = join(current, part);
    let entry;
    try {
      entry = await lstat(current);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT')
        return { directory: 'missing' as const, items: [], nextAfter: null, unsupportedNames: 0 };
      throw error;
    }
    if (!entry.isDirectory() || entry.isSymbolicLink())
      throw new Error('Invalid storage directory');
  }

  let visited = 0;
  let unsupportedNames = 0;
  const selected: string[] = [];
  const directory = await opendir(current);
  for await (const entry of directory) {
    if (++visited > maxEntries) throw new Error('Directory entry scan limit exceeded');
    if (!isInventoryComponent(entry.name)) {
      unsupportedNames++;
      continue;
    }
    if (after !== null && entry.name <= after) continue;
    // Keep only the first page plus one in memory; directory iteration order is not assumed.
    selected.push(entry.name);
    selected.sort();
    if (selected.length > PAGE_SIZE + 1) selected.pop();
  }
  const items = [];
  for (const name of selected.slice(0, PAGE_SIZE)) {
    const key = `org/${organisationId}/${kind}/${name}`;
    let entry;
    try {
      entry = await lstat(join(current, name));
    } catch {
      entry = null;
    }
    if (!entry || entry.isSymbolicLink() || !entry.isFile()) {
      items.push({
        key,
        file: 'unverifiable' as const,
        hardlinkCount: null,
        referenceMayExist: null,
        pendingErasureMayExist: null,
      });
      continue;
    }
    items.push({
      key,
      file: 'regular' as const,
      hardlinkCount: entry.nlink,
      referenceMayExist: await repository.referenceMayExist(key),
      pendingErasureMayExist: await repository.pendingErasureMayExist(key),
    });
  }
  return {
    directory: 'present' as const,
    items,
    nextAfter: selected.length > PAGE_SIZE ? selected[PAGE_SIZE - 1]! : null,
    unsupportedNames,
  };
}

/** List recorded keys in one organisation and observe their filesystem metadata, without repair. */
export async function listStorageReferences(
  repository: StorageInventoryRepository,
  root: string,
  organisationId: string,
  kind: StorageReferenceKind,
  after: string | null,
) {
  if (
    !isInventoryComponent(organisationId) ||
    !['documents', 'pages', 'exports', 'templates'].includes(kind) ||
    (after !== null && !isInventoryComponent(after))
  )
    throw new Error('Invalid reference inventory request');
  const rootStat = await lstat(resolve(root));
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error('Invalid storage root');
  const rows = await repository.listReferences(organisationId, kind, after, PAGE_SIZE + 1);
  const page = rows.slice(0, PAGE_SIZE);
  const items = [];
  for (const row of page)
    items.push({
      recordId: row.id,
      key: row.storage_key,
      file: await observeFile(root, row.storage_key),
      documentHasDeletedAt:
        kind === 'documents' || kind === 'pages' ? row.deleted_at !== null : null,
    });
  return { items, nextAfter: rows.length > PAGE_SIZE ? page[page.length - 1]!.id : null };
}
