import { ErasureFilesRepository } from '../src/repositories/erasure-files-repo';
import { createHarness, registerAccount } from './helpers';

it('fails closed when an alias scan reaches its cap, even without a matching reference', async () => {
  const harness = await createHarness();
  try {
    const account = await registerAccount(harness);
    const parts: string[] = [];
    const values: string[] = [];
    for (let i = 0; i < 1024; i += 1) {
      parts.push("(?, ?, 'Legacy', 'invoice', '[]', ?, ?, ?)");
      values.push(
        `alias-${String(i).padStart(4, '0')}`,
        account.organisationId,
        `org//legacy/file-${i}.png`,
        '2000-01-01T00:00:00.000Z',
        '2000-01-01T00:00:00.000Z',
      );
    }
    await harness.db.execute(
      `INSERT INTO templates (id, organisation_id, name, document_type, fields, sample_storage_key, created_at, updated_at) VALUES ${parts.join(', ')}`,
      values,
    );
    const repo = new ErasureFilesRepository(harness.db);
    expect(await repo.isReferenced('org/owner/file.png')).toBe(true);
    await harness.db.execute('DELETE FROM templates WHERE id = ?', ['alias-1023']);
    expect(await repo.isReferenced('org/owner/file.png')).toBe(false);
  } finally {
    await harness.close();
  }
}, 30_000);
