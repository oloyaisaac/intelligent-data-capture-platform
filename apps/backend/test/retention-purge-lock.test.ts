import { DocumentsRepository } from '../src/repositories/document-repo';
import { createHarness, registerAccount } from './helpers';

it.each(['key', 'created_at', 'status'] as const)(
  'does not delete a selected document after its %s changes',
  async (change) => {
    const harness = await createHarness();
    try {
      const account = await registerAccount(harness);
      const upload = await harness.api.upload(account.accessToken);
      const documentId = upload.json<{ id: string }>().id;
      await harness.services.worker.drain();
      await harness.db.execute('UPDATE documents SET created_at = ? WHERE id = ?', [
        '2000-01-01T00:00:00.000Z',
        documentId,
      ]);
      const old = await harness.db.one<{ storage_key: string }>(
        'SELECT storage_key FROM documents WHERE id = ?',
        [documentId],
      );
      const original = DocumentsRepository.prototype.findExpiredForPurge;
      const selected = jest
        .spyOn(DocumentsRepository.prototype, 'findExpiredForPurge')
        .mockImplementationOnce(async function (this: DocumentsRepository, ...args) {
          const rows = await original.call(this, ...args);
          if (change === 'key')
            await harness.db.execute('UPDATE documents SET storage_key = ? WHERE id = ?', [
              `org/${account.organisationId}/documents/replacement.png`,
              documentId,
            ]);
          if (change === 'created_at')
            await harness.db.execute('UPDATE documents SET created_at = ? WHERE id = ?', [
              '2999-01-01T00:00:00.000Z',
              documentId,
            ]);
          if (change === 'status')
            await harness.db.execute("UPDATE documents SET status = 'failed' WHERE id = ?", [
              documentId,
            ]);
          return rows;
        });
      const deletion = jest.spyOn(harness.storage, 'delete');
      try {
        await expect(
          harness.services.documents.purgeExpired(account.organisationId, 90),
        ).rejects.toThrow('Retention purge incomplete');
        expect(deletion).not.toHaveBeenCalledWith(old!.storage_key);
        expect(await harness.storage.exists(old!.storage_key)).toBe(true);
        expect(
          await harness.db.one('SELECT deleted_at FROM documents WHERE id = ?', [documentId]),
        ).toEqual({ deleted_at: null });
      } finally {
        selected.mockRestore();
        deletion.mockRestore();
      }
    } finally {
      await harness.close();
    }
  },
);

it.each(['queued', 'running'] as const)(
  'defers purge for a %s extraction and succeeds after it is finished',
  async (state) => {
    const harness = await createHarness();
    try {
      const account = await registerAccount(harness);
      const upload = await harness.api.upload(account.accessToken);
      const id = upload.json<{ id: string }>().id;
      await harness.db.execute('UPDATE documents SET created_at = ? WHERE id = ?', [
        '2000-01-01T00:00:00.000Z',
        id,
      ]);
      await harness.db.execute('UPDATE jobs SET status = ? WHERE document_id = ? AND type = ?', [
        state,
        id,
        'extract_document',
      ]);
      const row = await harness.db.one<{ storage_key: string }>(
        'SELECT storage_key FROM documents WHERE id = ?',
        [id],
      );
      await expect(
        harness.services.documents.purgeExpired(account.organisationId, 90),
      ).rejects.toThrow('Retention purge incomplete');
      expect(await harness.storage.exists(row!.storage_key)).toBe(true);
      expect(await harness.db.one('SELECT deleted_at FROM documents WHERE id = ?', [id])).toEqual({
        deleted_at: null,
      });
      await harness.db.execute(
        "UPDATE jobs SET status = 'succeeded' WHERE document_id = ? AND type = ?",
        [id, 'extract_document'],
      );
      expect(await harness.services.documents.purgeExpired(account.organisationId, 90)).toBe(1);
      expect(await harness.storage.exists(row!.storage_key)).toBe(false);
      expect(
        await harness.db.query('SELECT id FROM audit_logs WHERE action = ? AND target_id = ?', [
          'retention.purged',
          id,
        ]),
      ).toHaveLength(1);
    } finally {
      await harness.close();
    }
  },
);

it('serializes reprocessing and competing purges behind the document lock', async () => {
  const harness = await createHarness();
  let release!: () => void;
  let notify!: () => void;
  const barrier = new Promise<void>((resolve) => {
    release = resolve;
  });
  const entered = new Promise<void>((resolve) => {
    notify = resolve;
  });
  let purge: Promise<number> | undefined;
  let competing: Promise<number> | undefined;
  let request: ReturnType<typeof harness.api.json> | undefined;
  const original = harness.storage.delete.bind(harness.storage);
  const deletion = jest.spyOn(harness.storage, 'delete').mockImplementationOnce(async (key) => {
    notify();
    await barrier;
    await original(key);
  });
  try {
    const account = await registerAccount(harness);
    const upload = await harness.api.upload(account.accessToken);
    const id = upload.json<{ id: string }>().id;
    await harness.services.worker.drain();
    await harness.db.execute('UPDATE documents SET created_at = ? WHERE id = ?', [
      '2000-01-01T00:00:00.000Z',
      id,
    ]);
    purge = harness.services.documents.purgeExpired(account.organisationId, 90);
    await entered;
    competing = harness.services.documents.purgeExpired(account.organisationId, 90);
    request = harness.api.json('POST', `/api/v1/documents/${id}/reprocess`, {
      token: account.accessToken,
    });
    release();
    expect(await purge).toBe(1);
    expect(await competing).toBe(0);
    expect((await request).statusCode).toBe(404);
    expect(deletion).toHaveBeenCalledTimes(1);
    expect(
      await harness.db.query('SELECT id FROM audit_logs WHERE action = ? AND target_id = ?', [
        'retention.purged',
        id,
      ]),
    ).toHaveLength(1);
  } finally {
    release();
    if (purge) await purge.catch(() => undefined);
    if (competing) await competing.catch(() => undefined);
    if (request) await request.catch(() => undefined);
    deletion.mockRestore();
    await harness.close();
  }
});

it.each([0, 365])(
  'defers deletion if the retention policy changes to %i days after selection',
  async (policy) => {
    const harness = await createHarness();
    try {
      const account = await registerAccount(harness);
      const upload = await harness.api.upload(account.accessToken);
      const id = upload.json<{ id: string }>().id;
      await harness.services.worker.drain();
      await harness.db.execute('UPDATE documents SET created_at = ? WHERE id = ?', [
        '2000-01-01T00:00:00.000Z',
        id,
      ]);
      const row = await harness.db.one<{ storage_key: string }>(
        'SELECT storage_key FROM documents WHERE id = ?',
        [id],
      );
      const original = DocumentsRepository.prototype.findExpiredForPurge;
      const selected = jest
        .spyOn(DocumentsRepository.prototype, 'findExpiredForPurge')
        .mockImplementationOnce(async function (this: DocumentsRepository, ...args) {
          const rows = await original.call(this, ...args);
          await harness.db.execute('UPDATE organisations SET retention_days = ? WHERE id = ?', [
            policy,
            account.organisationId,
          ]);
          return rows;
        });
      try {
        await expect(
          harness.services.documents.purgeExpired(account.organisationId, 90),
        ).rejects.toThrow('Retention purge incomplete');
        expect(await harness.storage.exists(row!.storage_key)).toBe(true);
        expect(await harness.db.one('SELECT deleted_at FROM documents WHERE id = ?', [id])).toEqual(
          { deleted_at: null },
        );
        expect(
          await harness.db.query('SELECT id FROM audit_logs WHERE action = ? AND target_id = ?', [
            'retention.purged',
            id,
          ]),
        ).toHaveLength(0);
      } finally {
        selected.mockRestore();
      }
    } finally {
      await harness.close();
    }
  },
);
