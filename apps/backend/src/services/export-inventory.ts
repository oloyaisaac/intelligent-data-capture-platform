import { createHash } from 'node:crypto';
import { lstat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type {
  ExportInventoryRepository,
  InventoryExport,
} from '../repositories/export-inventory-repo';
import { assertSafeKey, buildStorageKey } from '../storage';

export type FileObservation = 'present' | 'missing' | 'unverifiable';

/**
 * Examine only metadata; reject symlinks and uncertain errors instead of treating them as absent.
 * The trusted root's ancestors and all of these checks can still change concurrently.
 */
export async function observeFile(root: string, key: string): Promise<FileObservation> {
  try {
    assertSafeKey(key);
    const absoluteRoot = resolve(root);
    const rootStat = await lstat(absoluteRoot);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) return 'unverifiable';
    const parts = key.split('/');
    let current = absoluteRoot;
    for (let index = 0; index < parts.length; index += 1) {
      current = join(current, parts[index]!);
      let entry;
      try {
        entry = await lstat(current);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'missing';
        return 'unverifiable';
      }
      if (entry.isSymbolicLink()) return 'unverifiable';
      if (index < parts.length - 1 && !entry.isDirectory()) return 'unverifiable';
      if (index === parts.length - 1) return entry.isFile() ? 'present' : 'unverifiable';
    }
  } catch {
    // A missing/unreadable root or invalid key is not evidence that a file is absent.
  }
  return 'unverifiable';
}

function publicRow(row: InventoryExport) {
  return {
    id: row.id,
    organisationId: row.organisation_id,
    format: row.format,
    status: row.status,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    hasStoredKey: row.storage_key !== null,
  };
}

export async function listExportInventory(
  repository: ExportInventoryRepository,
  after: string | null,
) {
  const rows = await repository.list(after, 101);
  const page = rows.slice(0, 100);
  return {
    items: page.map(publicRow),
    nextAfter: rows.length > 100 ? page[page.length - 1]!.id : null,
  };
}

export async function inspectExportInventory(
  repository: ExportInventoryRepository,
  storageRoot: string,
  id: string,
) {
  const row = await repository.find(id);
  if (!row) return null;
  // Older builds generated this deterministic candidate from the export row. It is not proof that
  // any existing object belongs to the row, nor does it cover rows removed from the database.
  const canonical =
    row.format === 'csv' || row.format === 'xlsx'
      ? buildStorageKey({
          organisationId: row.organisation_id,
          id: row.id,
          kind: 'exports',
          extension: row.format,
        })
      : null;
  const keys = [
    ...(row.storage_key !== null ? [{ source: 'stored', key: row.storage_key }] : []),
    ...(canonical !== null ? [{ source: 'canonicalCandidate', key: canonical }] : []),
  ];
  const observations = [];
  for (const { source, key } of keys) {
    observations.push({
      source,
      keySha256: createHash('sha256').update(key).digest('hex'),
      file: await observeFile(storageRoot, key),
      referencedElsewhere: await repository.referencedElsewhere(row.id, key),
      pendingErasure: await repository.pendingErasure(key),
    });
  }
  return { export: publicRow(row), observations };
}
