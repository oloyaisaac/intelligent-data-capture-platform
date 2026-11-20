import { ExportsRepository } from '../src/repositories/connector-repo';
import { createLogger } from '../src/logger';
import { createHarness, registerAccount } from './helpers';

it.each(['partial write', 'ready update failure', 'lost ready acknowledgement'] as const)(
  'tracks a possibly written export after %s and retries deletion',
  async (scenario) => {
    const logs: string[] = [];
    const harness = await createHarness(
      {},
      {
        logger: createLogger({ level: 'debug', sink: (line) => logs.push(line) }),
      },
    );
    try {
      const account = await registerAccount(harness);
      const originalPut = harness.storage.put.bind(harness.storage);
      const originalReady = ExportsRepository.prototype.markReady;
      const put = jest.spyOn(harness.storage, 'put');
      const ready = jest.spyOn(ExportsRepository.prototype, 'markReady');
      if (scenario === 'partial write') {
        put.mockImplementationOnce(async (key, buffer) => {
          await originalPut(key, buffer);
          throw new Error('SECRET-EXPORT-PATH');
        });
      } else if (scenario === 'ready update failure') {
        ready.mockRejectedValueOnce(new Error('SECRET-EXPORT-PATH'));
      } else {
        ready.mockImplementationOnce(async function (this: ExportsRepository, ...args) {
          await originalReady.call(this, ...args);
          throw new Error('SECRET-EXPORT-PATH');
        });
      }
      try {
        const response = await harness.api.json('POST', '/api/v1/exports', {
          token: account.accessToken,
          body: { format: 'csv' },
        });
        expect(response.statusCode).toBe(500);
        expect(response.body).not.toContain('SECRET-EXPORT-PATH');
      } finally {
        put.mockRestore();
        ready.mockRestore();
      }
      const row = await harness.db.one<{
        id: string;
        status: string;
        storage_key: string | null;
        expires_at: string | null;
      }>('SELECT id, status, storage_key, expires_at FROM exports WHERE organisation_id = ?', [
        account.organisationId,
      ]);
      expect(row?.status).toBe('failed');
      expect(row?.storage_key).toBeTruthy();
      expect(row?.expires_at).toBeTruthy();
      expect(await harness.storage.exists(row!.storage_key!)).toBe(true);
      expect(logs.join('\n')).not.toContain('SECRET-EXPORT-PATH');
      const failure = jest
        .spyOn(harness.storage, 'delete')
        .mockRejectedValueOnce(new Error('SECRET-DELETE-PATH'));
      try {
        expect(
          (await harness.services.maintenance.runOnce(new Date('2999-01-01T00:00:00.000Z')))
            .exportsExpired,
        ).toBe(0);
        expect(await harness.storage.exists(row!.storage_key!)).toBe(true);
      } finally {
        failure.mockRestore();
      }
      expect(
        (await harness.services.maintenance.runOnce(new Date('2999-01-01T00:00:00.000Z')))
          .exportsExpired,
      ).toBe(1);
      expect(await harness.storage.exists(row!.storage_key!)).toBe(false);
      expect(
        await harness.db.one('SELECT status, storage_key FROM exports WHERE id = ?', [row!.id]),
      ).toEqual({ status: 'expired', storage_key: null });
      expect(logs.join('\n')).not.toContain('SECRET-DELETE-PATH');
    } finally {
      await harness.close();
    }
  },
);

it('keeps the reserved key for offline investigation if failure recording also fails', async () => {
  const logs: string[] = [];
  const harness = await createHarness(
    {},
    {
      logger: createLogger({ level: 'debug', sink: (line) => logs.push(line) }),
    },
  );
  const ready = jest
    .spyOn(ExportsRepository.prototype, 'markReady')
    .mockRejectedValueOnce(new Error('SECRET-READY'));
  const failed = jest
    .spyOn(ExportsRepository.prototype, 'markFailed')
    .mockRejectedValueOnce(new Error('SECRET-FAILURE'));
  try {
    const account = await registerAccount(harness);
    const response = await harness.api.json('POST', '/api/v1/exports', {
      token: account.accessToken,
      body: { format: 'csv' },
    });
    expect(response.statusCode).toBe(500);
    const row = await harness.db.one<{
      status: string;
      storage_key: string | null;
      expires_at: string | null;
    }>('SELECT status, storage_key, expires_at FROM exports WHERE organisation_id = ?', [
      account.organisationId,
    ]);
    expect(row).toMatchObject({ status: 'queued', expires_at: null });
    expect(row?.storage_key).toBeTruthy();
    expect(
      (await harness.services.maintenance.runOnce(new Date('2999-01-01T00:00:00.000Z')))
        .exportsExpired,
    ).toBe(0);
    expect(await harness.storage.exists(row!.storage_key!)).toBe(true);
    expect(logs.join('\n')).not.toContain('SECRET-');
  } finally {
    ready.mockRestore();
    failed.mockRestore();
    await harness.close();
  }
});

it('does not write export bytes if the key reservation fails', async () => {
  const harness = await createHarness();
  const reserve = jest
    .spyOn(ExportsRepository.prototype, 'reserveStorageKey')
    .mockRejectedValueOnce(new Error('reservation failed'));
  const put = jest.spyOn(harness.storage, 'put');
  try {
    const account = await registerAccount(harness);
    const response = await harness.api.json('POST', '/api/v1/exports', {
      token: account.accessToken,
      body: { format: 'csv' },
    });
    expect(response.statusCode).toBe(500);
    expect(put).not.toHaveBeenCalled();
    expect(
      await harness.db.one('SELECT status, storage_key FROM exports WHERE organisation_id = ?', [
        account.organisationId,
      ]),
    ).toEqual({ status: 'failed', storage_key: null });
  } finally {
    reserve.mockRestore();
    put.mockRestore();
    await harness.close();
  }
});

it('does not infer that a queued export writer is dead just because time passed', async () => {
  const harness = await createHarness();
  try {
    const account = await registerAccount(harness);
    let unblock!: () => void;
    let notify!: () => void;
    const blocked = new Promise<void>((resolve) => {
      unblock = resolve;
    });
    const started = new Promise<void>((resolve) => {
      notify = resolve;
    });
    const original = harness.storage.put.bind(harness.storage);
    const put = jest.spyOn(harness.storage, 'put').mockImplementationOnce(async (key, data) => {
      await original(key, data);
      notify();
      await blocked;
    });
    const request = harness.api.json('POST', '/api/v1/exports', {
      token: account.accessToken,
      body: { format: 'csv' },
    });
    try {
      await started;
      const row = await harness.db.one<{
        status: string;
        storage_key: string | null;
        expires_at: string | null;
      }>('SELECT status, storage_key, expires_at FROM exports WHERE organisation_id = ?', [
        account.organisationId,
      ]);
      expect(row?.status).toBe('queued');
      expect(row?.storage_key).toBeTruthy();
      expect(row?.expires_at).toBeNull();
      expect(
        (await harness.services.maintenance.runOnce(new Date('2999-01-01T00:00:00.000Z')))
          .exportsExpired,
      ).toBe(0);
      expect(await harness.storage.exists(row!.storage_key!)).toBe(true);
    } finally {
      unblock();
      await request;
      put.mockRestore();
    }
  } finally {
    await harness.close();
  }
});
