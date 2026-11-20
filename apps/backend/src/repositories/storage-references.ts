import type { Database } from '../db/database';

/**
 * Known database references across all organisations, including soft-deleted rows. This is a
 * point-in-time check only, not a lock or proof that keys cannot be reused by another writer.
 * A retention purge excludes its own document and pages; export expiry excludes its own row.
 */
export async function hasStorageReference(
  db: Database,
  key: string,
  excluding: { documentId?: string; exportId?: string } = {},
): Promise<boolean> {
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
  return row !== null;
}
