import { createLogger } from '../src/logger';
import { ExportsRepository } from '../src/repositories/connector-repo';
import { createHarness, registerAccount } from './helpers';

it('rejects a colliding upload without overwriting or deleting pre-existing bytes', async () => {
  const logs: string[] = [];
  const harness = await createHarness(
    {},
    { logger: createLogger({ level: 'debug', sink: (line) => logs.push(line) }) },
  );
  try {
    const account = await registerAccount(harness);
    const original = harness.storage.put.bind(harness.storage);
    let key = '';
    const put = jest.spyOn(harness.storage, 'put').mockImplementationOnce(async (value, bytes) => {
      key = value;
      await original(value, Buffer.from('ORIGINAL-SECRET'));
      await original(value, bytes);
    });
    const deletion = jest.spyOn(harness.storage, 'delete');
    try {
      const response = await harness.api.upload(account.accessToken);
      expect(response.statusCode).toBe(500);
      expect(response.body).not.toContain('ORIGINAL-SECRET');
      expect((await harness.storage.get(key)).toString()).toBe('ORIGINAL-SECRET');
      expect(deletion).not.toHaveBeenCalled();
      expect(
        await harness.db.query('SELECT id FROM documents WHERE organisation_id = ?', [
          account.organisationId,
        ]),
      ).toHaveLength(0);
      expect(logs.join('\n')).not.toContain('ORIGINAL-SECRET');
    } finally {
      put.mockRestore();
      deletion.mockRestore();
    }
  } finally {
    await harness.close();
  }
});

it('keeps a colliding export reserved but ineligible for automatic expiry', async () => {
  const logs: string[] = [];
  const harness = await createHarness(
    {},
    { logger: createLogger({ level: 'debug', sink: (line) => logs.push(line) }) },
  );
  try {
    const account = await registerAccount(harness);
    const original = harness.storage.put.bind(harness.storage);
    let key = '';
    const put = jest.spyOn(harness.storage, 'put').mockImplementationOnce(async (value, bytes) => {
      key = value;
      await original(value, Buffer.from('ORIGINAL-SECRET'));
      await original(value, bytes);
    });
    const deletion = jest.spyOn(harness.storage, 'delete');
    try {
      const response = await harness.api.json('POST', '/api/v1/exports', {
        token: account.accessToken,
        body: { format: 'csv' },
      });
      expect(response.statusCode).toBe(500);
      expect(response.body).not.toContain('ORIGINAL-SECRET');
      const row = await harness.db.one<{
        id: string;
        status: string;
        storage_key: string;
        expires_at: string | null;
      }>('SELECT id, status, storage_key, expires_at FROM exports WHERE organisation_id = ?', [
        account.organisationId,
      ]);
      expect(row).toMatchObject({ status: 'queued', storage_key: key, expires_at: null });
      expect((await harness.storage.get(key)).toString()).toBe('ORIGINAL-SECRET');
      expect(
        (await harness.services.maintenance.runOnce(new Date('2999-01-01T00:00:00.000Z')))
          .exportsExpired,
      ).toBe(0);
      expect((await harness.storage.get(key)).toString()).toBe('ORIGINAL-SECRET');
      expect(deletion).not.toHaveBeenCalledWith(key);
      expect(
        await harness.db.query('SELECT id FROM audit_logs WHERE action = ? AND target_id = ?', [
          'export.created',
          row!.id,
        ]),
      ).toHaveLength(0);
      expect(logs.join('\n')).toContain('export key collision requires investigation');
      expect(logs.join('\n')).not.toContain('ORIGINAL-SECRET');
    } finally {
      put.mockRestore();
      deletion.mockRestore();
    }
  } finally {
    await harness.close();
  }
});

it.each(['uncertain storage failure', 'lost reservation acknowledgement'] as const)(
  'does not schedule an unknown existing export object for deletion after %s',
  async (scenario) => {
    const harness = await createHarness();
    try {
      const account = await registerAccount(harness);
      const put = harness.storage.put.bind(harness.storage);
      let key = '';
      const storageSpy = jest.spyOn(harness.storage, 'put');
      const reserveOriginal = ExportsRepository.prototype.reserveStorageKey;
      const reserveSpy = jest.spyOn(ExportsRepository.prototype, 'reserveStorageKey');
      if (scenario === 'uncertain storage failure') {
        storageSpy.mockImplementationOnce(async (value) => {
          key = value;
          await put(value, Buffer.from('pre-existing-object'));
          throw new Error('synthetic storage error with unknown ownership');
        });
      } else {
        reserveSpy.mockImplementationOnce(async function (this: ExportsRepository, id, value) {
          key = value;
          await put(value, Buffer.from('pre-existing-object'));
          expect(await reserveOriginal.call(this, id, value)).toBe(true);
          throw new Error('synthetic lost acknowledgement');
        });
      }
      try {
        const response = await harness.api.json('POST', '/api/v1/exports', {
          token: account.accessToken,
          body: { format: 'csv' },
        });
        expect(response.statusCode).toBe(500);
        const row = await harness.db.one(
          'SELECT status, storage_key, expires_at FROM exports WHERE organisation_id = ?',
          [account.organisationId],
        );
        expect(row).toEqual({ status: 'queued', storage_key: key, expires_at: null });
        expect(
          (await harness.services.maintenance.runOnce(new Date('2999-01-01T00:00:00.000Z')))
            .exportsExpired,
        ).toBe(0);
        expect((await harness.storage.get(key)).toString()).toBe('pre-existing-object');
      } finally {
        storageSpy.mockRestore();
        reserveSpy.mockRestore();
      }
    } finally {
      await harness.close();
    }
  },
);
