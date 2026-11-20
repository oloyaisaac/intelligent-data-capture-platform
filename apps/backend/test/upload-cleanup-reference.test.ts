import { createLogger } from '../src/logger';
import { DocumentsRepository } from '../src/repositories/document-repo';
import { AuditRepository } from '../src/repositories/system-repo';
import { createHarness, registerAccount } from './helpers';

it.each(['exact reference', 'path alias', 'reference lookup failure'] as const)(
  'does not remove an uncommitted upload after %s',
  async (scenario) => {
    const logs: string[] = [];
    const harness = await createHarness(
      {},
      { logger: createLogger({ level: 'debug', sink: (line) => logs.push(line) }) },
    );
    try {
      const account = await registerAccount(harness);
      const other = await registerAccount(harness, { email: 'other-cleanup-owner@example.com' });
      let key = '';
      const originalPut = harness.storage.put.bind(harness.storage);
      const put = jest
        .spyOn(harness.storage, 'put')
        .mockImplementationOnce(async (storageKey, buffer) => {
          key = storageKey;
          await originalPut(storageKey, buffer);
          if (scenario !== 'reference lookup failure') {
            const reference =
              scenario === 'path alias' ? storageKey.replace('/', '//') : storageKey;
            await harness.db.execute(
              `INSERT INTO templates (id, organisation_id, name, document_type, fields, sample_storage_key, created_at, updated_at)
             VALUES (?, ?, 'Synthetic', 'invoice', '[]', ?, ?, ?)`,
              [
                'other-reference',
                other.organisationId,
                reference,
                '2000-01-01T00:00:00.000Z',
                '2000-01-01T00:00:00.000Z',
              ],
            );
          }
        });
      const originalAudit = AuditRepository.prototype.record;
      const audit = jest
        .spyOn(AuditRepository.prototype, 'record')
        .mockImplementation(async function (this: AuditRepository, input) {
          if (input.action === 'document.uploaded') throw new Error('SYNTHETIC-AUDIT-SECRET');
          return originalAudit.call(this, input);
        });
      const lookup =
        scenario === 'reference lookup failure'
          ? jest
              .spyOn(DocumentsRepository.prototype, 'hasAnyStorageReference')
              .mockRejectedValueOnce(new Error('SYNTHETIC-LOOKUP-SECRET'))
          : undefined;
      const deletion = jest.spyOn(harness.storage, 'delete');
      try {
        const response = await harness.api.upload(account.accessToken);
        expect(response.statusCode).toBe(500);
        expect(response.body).not.toContain('SYNTHETIC-');
        expect(key).not.toBe('');
        expect(await harness.storage.exists(key)).toBe(true);
        expect(deletion).not.toHaveBeenCalledWith(key);
        expect(
          await harness.db.query('SELECT id FROM documents WHERE storage_key = ?', [key]),
        ).toHaveLength(0);
        expect(logs.join('\n')).not.toContain('SYNTHETIC-');
      } finally {
        deletion.mockRestore();
        lookup?.mockRestore();
        audit.mockRestore();
        put.mockRestore();
      }
    } finally {
      await harness.close();
    }
  },
);

it('preserves an aliased upload key after an idempotency race returns the winning document', async () => {
  const harness = await createHarness();
  try {
    const account = await registerAccount(harness);
    const other = await registerAccount(harness, { email: 'duplicate-cleanup-owner@example.com' });
    const original = harness.storage.put.bind(harness.storage);
    let losingKey = '';
    const put = jest.spyOn(harness.storage, 'put').mockImplementationOnce(async (key, buffer) => {
      losingKey = key;
      await original(key, buffer);
      await harness.db.execute(
        `INSERT INTO templates (id, organisation_id, name, document_type, fields, sample_storage_key, created_at, updated_at)
         VALUES (?, ?, 'Synthetic', 'invoice', '[]', ?, ?, ?)`,
        [
          'other-reference',
          other.organisationId,
          key.replace('/', '//'),
          '2000-01-01T00:00:00.000Z',
          '2000-01-01T00:00:00.000Z',
        ],
      );
      const winner = await harness.api.upload(account.accessToken, {
        idempotencyKey: 'racing-upload',
      });
      expect(winner.statusCode).toBe(201);
    });
    const deletion = jest.spyOn(harness.storage, 'delete');
    try {
      const duplicate = await harness.api.upload(account.accessToken, {
        idempotencyKey: 'racing-upload',
      });
      expect(duplicate.statusCode).toBe(200);
      expect(duplicate.json<{ duplicate: boolean }>().duplicate).toBe(true);
      expect(losingKey).not.toBe('');
      expect(await harness.storage.exists(losingKey)).toBe(true);
      expect(deletion).not.toHaveBeenCalledWith(losingKey);
    } finally {
      deletion.mockRestore();
      put.mockRestore();
    }
  } finally {
    await harness.close();
  }
});
