import { ErasureFilesRepository } from '../src/repositories/erasure-files-repo';
import { silentLogger } from '../src/logger';
import { processErasureFiles } from '../src/services/erasure-files';
import { createHarness, registerAccount, type Harness } from './helpers';

type Reference = 'document' | 'page' | 'export' | 'template';

async function addReference(
  harness: Harness,
  account: Awaited<ReturnType<typeof registerAccount>>,
  kind: Reference,
  key: string,
): Promise<() => Promise<void>> {
  if (kind === 'document' || kind === 'page') {
    const upload = await harness.api.upload(account.accessToken);
    const id = upload.json<{ id: string }>().id;
    const table = kind === 'document' ? 'documents' : 'document_pages';
    const column = kind === 'document' ? 'id' : 'document_id';
    await harness.db.execute(`UPDATE ${table} SET storage_key = ? WHERE ${column} = ?`, [key, id]);
    return () =>
      harness.db.execute(`UPDATE ${table} SET storage_key = ? WHERE ${column} = ?`, [
        `${key}.other`,
        id,
      ]);
  }
  if (kind === 'export') {
    await harness.db.execute(
      `INSERT INTO exports (id, organisation_id, requested_by, format, filter, storage_key, status, expires_at, created_at)
       VALUES (?, ?, ?, 'csv', '{}', ?, 'ready', ?, ?)`,
      [
        'reference-export',
        account.organisationId,
        account.userId,
        key,
        '2999-01-01T00:00:00.000Z',
        '2001-01-01T00:00:00.000Z',
      ],
    );
    return () =>
      harness.db.execute('UPDATE exports SET storage_key = NULL WHERE id = ?', [
        'reference-export',
      ]);
  }
  await harness.db.execute(
    `INSERT INTO templates (id, organisation_id, name, document_type, fields, sample_storage_key, created_at, updated_at)
     VALUES (?, ?, 'Reference', 'invoice', '[]', ?, ?, ?)`,
    [
      'reference-template',
      account.organisationId,
      key,
      '2001-01-01T00:00:00.000Z',
      '2001-01-01T00:00:00.000Z',
    ],
  );
  return () =>
    harness.db.execute('UPDATE templates SET sample_storage_key = NULL WHERE id = ?', [
      'reference-template',
    ]);
}

const references: Reference[] = ['document', 'page', 'export', 'template'];

it.each(references)(
  'includes inactive or deleted %s references in the safety check',
  async (kind) => {
    const harness = await createHarness();
    try {
      const account = await registerAccount(harness);
      const key = `org/${account.organisationId}/documents/reference.png`;
      await addReference(harness, account, kind, key);
      if (kind === 'document' || kind === 'page') {
        await harness.db.execute("UPDATE documents SET deleted_at = ?, status = 'deleted'", [
          '2000-01-01T00:00:00.000Z',
        ]);
      } else if (kind === 'export') {
        await harness.db.execute("UPDATE exports SET status = 'expired' WHERE id = ?", [
          'reference-export',
        ]);
      } else {
        await harness.db.execute('UPDATE templates SET active = 0 WHERE id = ?', [
          'reference-template',
        ]);
      }
      expect(await new ErasureFilesRepository(harness.db).isReferenced(key)).toBe(true);
    } finally {
      await harness.close();
    }
  },
);

describe.each(['retention', 'erasure', 'expired export'] as const)(
  '%s file deletion',
  (operation) => {
    it.each(
      references.flatMap((kind) => [
        { kind, alias: false },
        { kind, alias: true },
      ]),
    )(
      'fails closed for another tenant’s $kind reference (path alias: $alias) and retries',
      async ({ kind, alias }) => {
        const harness = await createHarness();
        try {
          const owner = await registerAccount(harness);
          const other = await registerAccount(harness, { email: 'other-reference@example.com' });
          let key = `org/${owner.organisationId}/documents/source.png`;
          let documentId = '';
          if (operation === 'retention') {
            const upload = await harness.api.upload(owner.accessToken);
            documentId = upload.json<{ id: string }>().id;
            await harness.services.worker.drain();
            const row = await harness.db.one<{ storage_key: string }>(
              'SELECT storage_key FROM documents WHERE id = ?',
              [documentId],
            );
            key = row!.storage_key;
            await harness.db.execute('UPDATE documents SET created_at = ? WHERE id = ?', [
              '2000-01-01T00:00:00.000Z',
              documentId,
            ]);
          } else {
            await harness.storage.put(key, Buffer.from('sensitive'));
          }
          if (operation === 'erasure') {
            await harness.db.execute(
              'INSERT INTO erasure_file_deletions (id, user_id, storage_key, created_at) VALUES (?, ?, ?, ?)',
              ['erase', owner.userId, key, '2000-01-01T00:00:00.000Z'],
            );
          }
          if (operation === 'expired export') {
            await harness.db.execute(
              `INSERT INTO exports (id, organisation_id, requested_by, format, filter, storage_key, status, expires_at, created_at)
          VALUES (?, ?, ?, 'csv', '{}', ?, 'ready', ?, ?)`,
              [
                'expired-export',
                owner.organisationId,
                owner.userId,
                key,
                '2001-01-01T00:00:00.000Z',
                '2000-01-01T00:00:00.000Z',
              ],
            );
          }
          const referenceKey = alias ? key.replace('/', '//') : key;
          const removeReference = await addReference(harness, other, kind, referenceKey);
          const attempt = async (): Promise<number> => {
            if (operation === 'retention')
              return harness.services.documents.purgeExpired(owner.organisationId, 90);
            if (operation === 'erasure')
              return processErasureFiles(
                new ErasureFilesRepository(harness.db),
                harness.storage,
                silentLogger,
              );
            return (await harness.services.maintenance.runOnce()).exportsExpired;
          };
          if (operation === 'retention') await expect(attempt()).rejects.toThrow();
          else expect(await attempt()).toBe(0);
          expect(await harness.storage.exists(key)).toBe(true);
          if (operation === 'retention')
            expect(
              await harness.db.one('SELECT deleted_at FROM documents WHERE id = ?', [documentId]),
            ).toEqual({ deleted_at: null });
          if (operation === 'erasure')
            expect(
              await harness.db.one('SELECT storage_key FROM erasure_file_deletions WHERE id = ?', [
                'erase',
              ]),
            ).toEqual({ storage_key: key });
          if (operation === 'expired export')
            expect(
              await harness.db.one('SELECT status, storage_key FROM exports WHERE id = ?', [
                'expired-export',
              ]),
            ).toEqual({ status: 'ready', storage_key: key });
          await removeReference();
          expect(await attempt()).toBe(1);
          expect(await harness.storage.exists(key)).toBe(false);
        } finally {
          await harness.close();
        }
      },
    );
  },
);

describe.each(['retention', 'expired export'] as const)(
  '%s with a pending erasure for the same file',
  (operation) => {
    it.each([false, true])('defers when the queue key is an alias: %s', async (alias) => {
      const harness = await createHarness();
      try {
        const owner = await registerAccount(harness);
        const other = await registerAccount(harness, { email: 'pending-erasure@example.com' });
        let key = `org/${owner.organisationId}/exports/example.csv`;
        let documentId = '';
        if (operation === 'retention') {
          const upload = await harness.api.upload(owner.accessToken);
          documentId = upload.json<{ id: string }>().id;
          await harness.services.worker.drain();
          const row = await harness.db.one<{ storage_key: string }>(
            'SELECT storage_key FROM documents WHERE id = ?',
            [documentId],
          );
          key = row!.storage_key;
          await harness.db.execute('UPDATE documents SET created_at = ? WHERE id = ?', [
            '2000-01-01T00:00:00.000Z',
            documentId,
          ]);
        } else {
          await harness.storage.put(key, Buffer.from('sensitive'));
          await harness.db.execute(
            `INSERT INTO exports (id, organisation_id, requested_by, format, filter, storage_key, status, expires_at, created_at)
             VALUES (?, ?, ?, 'csv', '{}', ?, 'ready', ?, ?)`,
            [
              'expired-export',
              owner.organisationId,
              owner.userId,
              key,
              '2001-01-01T00:00:00.000Z',
              '2000-01-01T00:00:00.000Z',
            ],
          );
        }
        await harness.db.execute(
          'INSERT INTO erasure_file_deletions (id, user_id, storage_key, created_at) VALUES (?, ?, ?, ?)',
          [
            'erasure',
            other.userId,
            alias ? key.replace('/', '//') : key,
            '2000-01-01T00:00:00.000Z',
          ],
        );
        const deletion = jest.spyOn(harness.storage, 'delete');
        const attempt = () =>
          operation === 'retention'
            ? harness.services.documents.purgeExpired(owner.organisationId, 90)
            : harness.services.maintenance.runOnce().then((report) => report.exportsExpired);
        if (operation === 'retention') await expect(attempt()).rejects.toThrow();
        else expect(await attempt()).toBe(0);
        expect(deletion).not.toHaveBeenCalledWith(key);
        expect(await harness.storage.exists(key)).toBe(true);
        expect(
          await harness.db.one('SELECT storage_key FROM erasure_file_deletions WHERE id = ?', [
            'erasure',
          ]),
        ).toEqual({ storage_key: alias ? key.replace('/', '//') : key });
        if (operation === 'retention') {
          expect(
            await harness.db.one('SELECT deleted_at FROM documents WHERE id = ?', [documentId]),
          ).toEqual({ deleted_at: null });
        } else {
          expect(
            await harness.db.one('SELECT status, storage_key FROM exports WHERE id = ?', [
              'expired-export',
            ]),
          ).toEqual({ status: 'ready', storage_key: key });
        }
        // Remove only a synthetic test fixture; real conflicts require authorized review.
        await harness.db.execute('DELETE FROM erasure_file_deletions WHERE id = ?', ['erasure']);
        expect(await attempt()).toBe(1);
        expect(await harness.storage.exists(key)).toBe(false);
      } finally {
        await harness.close();
      }
    });
  },
);
