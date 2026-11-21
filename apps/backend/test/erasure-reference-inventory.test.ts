import { hasPendingErasureReference } from '../src/repositories/storage-references';
import { ExportInventoryRepository } from '../src/repositories/export-inventory-repo';
import { createHarness } from './helpers';

it('detects exact and syntactic aliases after the first page, and fails closed at the bound', async () => {
  const harness = await createHarness();
  try {
    const rows: string[] = [];
    const values: string[] = [];
    for (let i = 0; i < 1023; i++) {
      rows.push('(?, ?, ?, ?)');
      values.push(
        `a-${String(i).padStart(4, '0')}`,
        'synthetic-user',
        `org//legacy/file-${i}.png`,
        '2000-01-01T00:00:00.000Z',
      );
    }
    await harness.db.execute(
      `INSERT INTO erasure_file_deletions (id, user_id, storage_key, created_at) VALUES ${rows.join(', ')}`,
      values,
    );
    const key = 'org/owner/file.png';
    expect(await hasPendingErasureReference(harness.db, key)).toBe(false);
    await harness.db.execute(
      'INSERT INTO erasure_file_deletions (id, user_id, storage_key, created_at) VALUES (?, ?, ?, ?)',
      ['z-match', 'synthetic-user', 'org//owner/file.png', '2000-01-01T00:00:00.000Z'],
    );
    expect(await hasPendingErasureReference(harness.db, key)).toBe(true);
    // A different key also fails closed when 1,024 aliases cannot all be checked within budget.
    expect(await hasPendingErasureReference(harness.db, 'org/owner/different.png')).toBe(true);
    expect(
      await new ExportInventoryRepository(harness.db).pendingErasure('org/owner/different.png'),
    ).toBe(true);
    expect(await hasPendingErasureReference(harness.db, 'org//owner/file.png')).toBe(true);
    expect(await hasPendingErasureReference(harness.db, '../escape')).toBe(true);
    await harness.db.execute('DELETE FROM erasure_file_deletions WHERE id = ?', ['z-match']);
    await harness.db.execute(
      'INSERT INTO erasure_file_deletions (id, user_id, storage_key, created_at) VALUES (?, ?, ?, ?)',
      ['exact', 'synthetic-user', key, '2000-01-01T00:00:00.000Z'],
    );
    expect(await hasPendingErasureReference(harness.db, key)).toBe(true);
  } finally {
    await harness.close();
  }
}, 30_000);
