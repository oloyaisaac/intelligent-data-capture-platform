import { posix } from 'node:path';
import type { Database } from '../db/database';
import { assertSafeKey } from '../storage';

const ALIAS_PAGE_SIZE = 128;
// Limit work on a single candidate; too many possible aliases require operator investigation.
const MAX_ALIASES_PER_SOURCE = 1024;

type ReferenceSource = {
  table: 'documents' | 'document_pages' | 'exports' | 'templates';
  keyColumn: 'storage_key' | 'sample_storage_key';
  exclusionColumn?: 'id' | 'document_id';
  excludedId?: string;
};

/**
 * Known database references across all organisations, including soft-deleted rows. This is a
 * point-in-time check only, not a lock or proof that keys cannot be reused by another writer.
 * A retention purge excludes its own document and pages; export expiry excludes its own row.
 * Non-canonical target keys are never eligible for automatic deletion. Existing syntactic path
 * aliases are checked in bounded pages because filesystem storage normalizes slashes and dots.
 * This does not detect symlink/hardlink aliases, case-insensitive filesystems or concurrent writes.
 */
export async function hasStorageReference(
  db: Database,
  key: string,
  excluding: { documentId?: string; exportId?: string } = {},
): Promise<boolean> {
  try {
    assertSafeKey(key);
  } catch {
    return true;
  }
  if (key.endsWith('/') || posix.normalize(key) !== key) return true;

  const documentFilter = excluding.documentId ? ' AND id <> ?' : '';
  const pageFilter = excluding.documentId ? ' AND document_id <> ?' : '';
  const exportFilter = excluding.exportId ? ' AND id <> ?' : '';
  const params: string[] = [key];
  if (excluding.documentId) params.push(excluding.documentId);
  params.push(key);
  if (excluding.documentId) params.push(excluding.documentId);
  params.push(key);
  if (excluding.exportId) params.push(excluding.exportId);
  params.push(key);
  const row = await db.one(
    `SELECT id FROM documents WHERE storage_key = ?${documentFilter}
     UNION ALL SELECT id FROM document_pages WHERE storage_key = ?${pageFilter}
     UNION ALL SELECT id FROM exports WHERE storage_key = ?${exportFilter}
     UNION ALL SELECT id FROM templates WHERE sample_storage_key = ? LIMIT 1`,
    params,
  );
  if (row) return true;

  const sources: ReferenceSource[] = [
    {
      table: 'documents',
      keyColumn: 'storage_key',
      exclusionColumn: 'id',
      excludedId: excluding.documentId,
    },
    {
      table: 'document_pages',
      keyColumn: 'storage_key',
      exclusionColumn: 'document_id',
      excludedId: excluding.documentId,
    },
    {
      table: 'exports',
      keyColumn: 'storage_key',
      exclusionColumn: 'id',
      excludedId: excluding.exportId,
    },
    { table: 'templates', keyColumn: 'sample_storage_key' },
  ];
  const identity = posix.resolve('/', key);
  for (const source of sources) {
    let after: string | undefined;
    let scanned = 0;
    while (true) {
      const conditions = [
        // These cover slash/dot segments that can normalize to a canonical key. The ..
        // predicate also covers legacy invalid paths; unsafe targets are refused above.
        `(${source.keyColumn} LIKE '%//%' OR ${source.keyColumn} LIKE '%/./%' OR ${source.keyColumn} LIKE './%' OR ${source.keyColumn} LIKE '%/.' OR ${source.keyColumn} LIKE '%/' OR ${source.keyColumn} LIKE '/%' OR ${source.keyColumn} LIKE '%..%')`,
      ];
      const values: Array<string | number> = [];
      if (source.excludedId && source.exclusionColumn) {
        conditions.push(`${source.exclusionColumn} <> ?`);
        values.push(source.excludedId);
      }
      if (after !== undefined) {
        conditions.push('id > ?');
        values.push(after);
      }
      values.push(ALIAS_PAGE_SIZE);
      // Table and column names come exclusively from the fixed source list above.
      const candidates = await db.query<{ id: string; key: string }>(
        `SELECT id, ${source.keyColumn} AS key FROM ${source.table}
         WHERE ${conditions.join(' AND ')} ORDER BY id LIMIT ?`,
        values,
      );
      if (candidates.some((candidate) => posix.resolve('/', candidate.key) === identity))
        return true;
      if (candidates.length < ALIAS_PAGE_SIZE) break;
      scanned += candidates.length;
      // We have not proved the remaining keys safe. Fail closed, never treat truncation as absence.
      if (scanned >= MAX_ALIASES_PER_SOURCE) return true;
      after = candidates[candidates.length - 1]!.id;
    }
  }
  return false;
}

/**
 * Check the pending erasure queue for an exact or syntactic alias. Optionally exclude the current
 * queue row when checking for competing work. Returns true on an unsafe key or an exhausted scan
 * budget, so false is only a bounded point-in-time database observation.
 */
export async function hasPendingErasureReference(
  db: Database,
  key: string,
  excludingId?: string,
): Promise<boolean> {
  try {
    assertSafeKey(key);
  } catch {
    return true;
  }
  if (key.endsWith('/') || posix.normalize(key) !== key) return true;
  const exclusion = excludingId === undefined ? '' : ' AND id <> ?';
  if (
    await db.one(
      `SELECT id FROM erasure_file_deletions WHERE storage_key = ?${exclusion} LIMIT 1`,
      excludingId === undefined ? [key] : [key, excludingId],
    )
  )
    return true;
  const identity = posix.resolve('/', key);
  let after: string | undefined;
  let scanned = 0;
  while (true) {
    const candidates = await db.query<{ id: string; key: string }>(
      `SELECT id, storage_key AS key FROM erasure_file_deletions
       WHERE (storage_key LIKE '%//%' OR storage_key LIKE '%/./%' OR storage_key LIKE './%'
         OR storage_key LIKE '%/.' OR storage_key LIKE '%/' OR storage_key LIKE '/%'
         OR storage_key LIKE '%..%') ${exclusion} ${after === undefined ? '' : 'AND id > ?'}
       ORDER BY id LIMIT ?`,
      [
        ...(excludingId === undefined ? [] : [excludingId]),
        ...(after === undefined ? [] : [after]),
        ALIAS_PAGE_SIZE,
      ],
    );
    if (candidates.some((candidate) => posix.resolve('/', candidate.key) === identity)) return true;
    if (candidates.length < ALIAS_PAGE_SIZE) return false;
    scanned += candidates.length;
    if (scanned >= MAX_ALIASES_PER_SOURCE) return true;
    after = candidates[candidates.length - 1]!.id;
  }
}
