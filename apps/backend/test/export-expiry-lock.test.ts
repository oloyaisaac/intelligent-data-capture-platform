import { createLogger } from '../src/logger';
import { MaintenanceRepository } from '../src/repositories/maintenance-repo';
import { createHarness, registerAccount } from './helpers';

it.each(['expiry', 'key', 'status'] as const)(
  'does not delete a stale export snapshot after %s changes',
  async (change) => {
    const harness = await createHarness();
    try {
      const account = await registerAccount(harness);
      const key = `org/${account.organisationId}/exports/old.csv`;
      await harness.storage.put(key, Buffer.from('synthetic'));
      await harness.db.execute(
        `INSERT INTO exports (id, organisation_id, requested_by, format, filter, storage_key, status, expires_at, created_at)
       VALUES (?, ?, ?, 'csv', '{}', ?, 'ready', ?, ?)`,
        [
          'test-export',
          account.organisationId,
          account.userId,
          key,
          '2000-01-01T00:00:00.000Z',
          '2000-01-01T00:00:00.000Z',
        ],
      );
      const original = MaintenanceRepository.prototype.expiredExports;
      const select = jest
        .spyOn(MaintenanceRepository.prototype, 'expiredExports')
        .mockImplementationOnce(async function (this: MaintenanceRepository, now) {
          const rows = await original.call(this, now);
          const update =
            change === 'expiry'
              ? ['expires_at', '2999-01-01T00:00:00.000Z']
              : change === 'key'
                ? ['storage_key', `org/${account.organisationId}/exports/replacement.csv`]
                : ['status', 'queued'];
          await harness.db.execute(`UPDATE exports SET ${update[0]} = ? WHERE id = ?`, [
            update[1],
            'test-export',
          ]);
          return rows;
        });
      const deletion = jest.spyOn(harness.storage, 'delete');
      try {
        expect(
          (await harness.services.maintenance.runOnce(new Date('2026-01-01T00:00:00.000Z')))
            .exportsExpired,
        ).toBe(0);
        expect(deletion).not.toHaveBeenCalledWith(key);
        expect(await harness.storage.exists(key)).toBe(true);
      } finally {
        select.mockRestore();
        deletion.mockRestore();
      }
    } finally {
      await harness.close();
    }
  },
);

it('never expires a queued export merely because it has an old expiry', async () => {
  const harness = await createHarness();
  try {
    const account = await registerAccount(harness);
    const key = `org/${account.organisationId}/exports/queued.csv`;
    await harness.storage.put(key, Buffer.from('synthetic'));
    await harness.db.execute(
      `INSERT INTO exports (id, organisation_id, requested_by, format, filter, storage_key, status, expires_at, created_at)
       VALUES (?, ?, ?, 'csv', '{}', ?, 'queued', ?, ?)`,
      [
        'queued-export',
        account.organisationId,
        account.userId,
        key,
        '2000-01-01T00:00:00.000Z',
        '2000-01-01T00:00:00.000Z',
      ],
    );
    expect((await harness.services.maintenance.runOnce()).exportsExpired).toBe(0);
    expect(await harness.storage.exists(key)).toBe(true);
    expect(
      await harness.db.one('SELECT status, storage_key FROM exports WHERE id = ?', [
        'queued-export',
      ]),
    ).toEqual({ status: 'queued', storage_key: key });
  } finally {
    await harness.close();
  }
});

it('keeps the export row retryable when metadata update fails after file deletion', async () => {
  const harness = await createHarness();
  try {
    const account = await registerAccount(harness);
    const key = `org/${account.organisationId}/exports/failure.csv`;
    await harness.storage.put(key, Buffer.from('synthetic'));
    await harness.db.execute(
      `INSERT INTO exports (id, organisation_id, requested_by, format, filter, storage_key, status, expires_at, created_at)
       VALUES (?, ?, ?, 'csv', '{}', ?, 'ready', ?, ?)`,
      [
        'failure-export',
        account.organisationId,
        account.userId,
        key,
        '2000-01-01T00:00:00.000Z',
        '2000-01-01T00:00:00.000Z',
      ],
    );
    const fail = jest
      .spyOn(MaintenanceRepository.prototype, 'markExportExpired')
      .mockRejectedValueOnce(new Error('synthetic'));
    try {
      expect((await harness.services.maintenance.runOnce()).exportsExpired).toBe(0);
    } finally {
      fail.mockRestore();
    }
    expect(await harness.storage.exists(key)).toBe(false);
    expect(
      await harness.db.one('SELECT status, storage_key FROM exports WHERE id = ?', [
        'failure-export',
      ]),
    ).toEqual({ status: 'ready', storage_key: key });
    expect((await harness.services.maintenance.runOnce()).exportsExpired).toBe(1);
    expect(
      await harness.db.one('SELECT status, storage_key FROM exports WHERE id = ?', [
        'failure-export',
      ]),
    ).toEqual({ status: 'expired', storage_key: null });
  } finally {
    await harness.close();
  }
});

it('does not log raw errors from failed maintenance steps', async () => {
  const logs: string[] = [];
  const harness = await createHarness(
    {},
    { logger: createLogger({ level: 'debug', sink: (line) => logs.push(line) }) },
  );
  const fail = jest
    .spyOn(MaintenanceRepository.prototype, 'organisationsWithRetention')
    .mockRejectedValueOnce(new Error('SYNTHETIC-CREDENTIAL'));
  try {
    await harness.services.maintenance.runOnce();
    expect(logs.join('\n')).toContain('maintenance step failed');
    expect(logs.join('\n')).not.toContain('SYNTHETIC-CREDENTIAL');
  } finally {
    fail.mockRestore();
    await harness.close();
  }
});
