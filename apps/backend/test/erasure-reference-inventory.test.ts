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
    expect(await hasPendingErasureReference(harness.db, key, 'exact')).toBe(false);
    await harness.db.execute(
      'INSERT INTO erasure_file_deletions (id, user_id, storage_key, created_at) VALUES (?, ?, ?, ?)',
      ['z-extra', 'synthetic-user', 'org//unrelated/last.png', '2000-01-01T00:00:00.000Z'],
    );
    expect(await hasPendingErasureReference(harness.db, key, 'exact')).toBe(true);
  } finally {
    await harness.close();
  }
}, 30_000);

it('excludes only the selected queue row while checking exact keys and paginated aliases', async () => {
  const harness = await createHarness();
  const key = 'org/owner/file.png';
  try {
    await harness.db.execute(
      'INSERT INTO erasure_file_deletions (id, user_id, storage_key, created_at) VALUES (?, ?, ?, ?)',
      ['selected', 'user-1', key, '2000-01-01T00:00:00.000Z'],
    );
    expect(await hasPendingErasureReference(harness.db, key, 'selected')).toBe(false);
    await harness.db.execute(
      'INSERT INTO erasure_file_deletions (id, user_id, storage_key, created_at) VALUES (?, ?, ?, ?)',
      ['duplicate', 'user-2', key, '2000-01-01T00:00:00.000Z'],
    );
    expect(await hasPendingErasureReference(harness.db, key, 'selected')).toBe(true);
    await harness.db.execute('DELETE FROM erasure_file_deletions WHERE id = ?', ['duplicate']);
    const rows: string[] = [];
    const values: string[] = [];
    for (let i = 0; i < 130; i++) {
      rows.push('(?, ?, ?, ?)');
      values.push(`a-${String(i).padStart(3, '0')}`, 'user', `org//other/${i}`, '2000');
    }
    rows.push('(?, ?, ?, ?)');
    values.push('z-alias', 'user', 'org//owner/file.png', '2000');
    await harness.db.execute(
      `INSERT INTO erasure_file_deletions (id, user_id, storage_key, created_at) VALUES ${rows.join(', ')}`,
      values,
    );
    expect(await hasPendingErasureReference(harness.db, key, 'selected')).toBe(true);
    await harness.db.execute('DELETE FROM erasure_file_deletions WHERE id = ?', ['z-alias']);
    expect(await hasPendingErasureReference(harness.db, key, 'selected')).toBe(false);
  } finally {
    await harness.close();
  }
});
