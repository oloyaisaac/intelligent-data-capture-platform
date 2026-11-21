import { MaintenanceRepository } from '../src/repositories/maintenance-repo';
import { createHarness, registerAccount, type Harness } from './helpers';
import { MaintenanceService } from '../src/services/maintenance-service';
import { silentLogger } from '../src/logger';

/**
 * Daily housekeeping (DEC-031).
 *
 * Three promises the product made but never performed on its own: purge documents past their
 * retention period, delete the bytes of an expired export, and clear dead sessions. Each is checked
 * here, plus the property that makes the job safe to run twice: it is idempotent.
 */
describe('maintenance scheduler', () => {
  let harness: Harness;

  beforeEach(async () => {
    harness = await createHarness();
  });

  afterEach(async () => {
    await harness.services.maintenance.stop();
    await harness.close();
  });

  const maintenance = () => harness.services.maintenance;

  it('waits for an active sweep on stop before allowing restart', async () => {
    let release!: (
      value: Awaited<ReturnType<MaintenanceRepository['organisationsWithRetention']>>,
    ) => void;
    let notifyStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      notifyStarted = resolve;
    });
    const pending = new Promise<
      Awaited<ReturnType<MaintenanceRepository['organisationsWithRetention']>>
    >((resolve) => {
      release = resolve;
    });
    const query = jest
      .spyOn(MaintenanceRepository.prototype, 'organisationsWithRetention')
      .mockImplementation(() => {
        notifyStarted();
        return pending;
      });
    try {
      const sweep = maintenance().runOnce();
      await started;
      let stopped = false;
      const stopping = maintenance()
        .stop()
        .then(() => {
          stopped = true;
        });
      await Promise.resolve();
      expect(stopped).toBe(false);
      expect(() => maintenance().start(1)).toThrow('Wait for maintenance to stop');
      release([]);
      await sweep;
      await stopping;
      expect(stopped).toBe(true);
      maintenance().start(60_000);
      expect(maintenance().isScheduled).toBe(true);
      await maintenance().stop();
    } finally {
      release([]);
      query.mockRestore();
    }
  });

  it('does not reschedule a sweep that finishes after stop', async () => {
    jest.useFakeTimers();
    let release!: (
      value: Awaited<ReturnType<MaintenanceRepository['organisationsWithRetention']>>,
    ) => void;
    const pending = new Promise<
      Awaited<ReturnType<MaintenanceRepository['organisationsWithRetention']>>
    >((resolve) => {
      release = resolve;
    });
    // Keep this timer test independent of real database I/O. Fake timers can block the
    // PostgreSQL driver's network scheduling before the retention step is reached.
    const query = jest.fn().mockReturnValue(pending);
    const scheduler = new MaintenanceService(
      {
        jobs: { enqueueRetentionIfAbsent: jest.fn() },
        transaction: jest.fn(),
        maintenance: {
          organisationsWithRetention: query,
          expiredExports: jest.fn().mockResolvedValue([]),
          expirePairingSessions: jest.fn().mockResolvedValue(0),
          deleteExpiredSessions: jest.fn().mockResolvedValue(0),
          deleteSpentResetTokens: jest.fn().mockResolvedValue(0),
        },
        erasureFiles: {
          listPending: jest.fn().mockResolvedValue([]),
          withLockedPending: jest.fn(),
          recordFailedAttempt: jest.fn(),
        },
      },
      harness.config,
      harness.storage,
      silentLogger,
    );
    try {
      scheduler.start(1);
      await jest.advanceTimersByTimeAsync(1);
      expect(query).toHaveBeenCalledTimes(1);
      const stopping = scheduler.stop();
      release([]);
      await stopping;
      await jest.advanceTimersByTimeAsync(60_000);
      expect(query).toHaveBeenCalledTimes(1);
      expect(scheduler.isScheduled).toBe(false);
      expect(jest.getTimerCount()).toBe(0);
    } finally {
      release([]);
      await scheduler.stop();
      jest.useRealTimers();
    }
  });

  it('enqueues one retention purge per organisation, and does not duplicate it', async () => {
    const account = await registerAccount(harness, { email: 'retention@example.com' });

    const first = await maintenance().runOnce();
    expect(first.retentionJobsEnqueued).toBe(1);

    const jobs = await harness.db.query<{ type: string; status: string }>(
      'SELECT type, status FROM jobs WHERE organisation_id = ? AND type = ?',
      [account.organisationId, 'retention_purge'],
    );
    expect(jobs).toHaveLength(1);
    expect(jobs[0].status).toBe('queued');

    // A second tick while the first is still waiting must not add another.
    const second = await maintenance().runOnce();
    expect(second.retentionJobsEnqueued).toBe(0);
  });

  it('skips organisations that chose to keep everything', async () => {
    const account = await registerAccount(harness, { email: 'keep-forever@example.com' });
    await harness.db.execute('UPDATE organisations SET retention_days = 0 WHERE id = ?', [
      account.organisationId,
    ]);

    const report = await maintenance().runOnce();
    expect(report.retentionJobsEnqueued).toBe(0);
  });

  it('deletes the file behind an expired export and marks it expired', async () => {
    const account = await registerAccount(harness, { email: 'exports@example.com' });
    const key = `org/${account.organisationId}/exports/old.csv`;
    await harness.storage.put(key, Buffer.from('a,b\n1,2\n'));

    await harness.db.execute(
      `INSERT INTO exports (id, organisation_id, requested_by, format, filter, row_count, storage_key, status, expires_at, created_at)
       VALUES (?, ?, ?, 'csv', '{}', 1, ?, 'ready', ?, ?)`,
      [
        'export-old',
        account.organisationId,
        account.userId,
        key,
        new Date(Date.now() - 60_000).toISOString(),
        new Date(Date.now() - 86_400_000).toISOString(),
      ],
    );

    const report = await maintenance().runOnce();
    expect(report.exportsExpired).toBe(1);

    expect(await harness.storage.exists(key)).toBe(false);
    const row = await harness.db.one<{ status: string; storage_key: string | null }>(
      'SELECT status, storage_key FROM exports WHERE id = ?',
      ['export-old'],
    );
    expect(row?.status).toBe('expired');
    expect(row?.storage_key).toBeNull();
  });

  it('keeps the key of an expired export when deletion fails and retries later', async () => {
    const account = await registerAccount(harness, { email: 'retry-export@example.com' });
    const key = `org/${account.organisationId}/exports/retry.csv`;
    await harness.storage.put(key, Buffer.from('private'));
    await harness.db.execute(
      `INSERT INTO exports (id, organisation_id, requested_by, format, filter, row_count, storage_key, status, expires_at, created_at)
       VALUES (?, ?, ?, 'csv', '{}', 1, ?, 'ready', ?, ?)`,
      [
        'export-retry',
        account.organisationId,
        account.userId,
        key,
        new Date(Date.now() - 60_000).toISOString(),
        new Date().toISOString(),
      ],
    );
    const deletion = jest
      .spyOn(harness.storage, 'delete')
      .mockRejectedValue(new Error('storage unavailable'));
    try {
      expect((await maintenance().runOnce()).exportsExpired).toBe(0);
      expect(
        await harness.db.one('SELECT status, storage_key FROM exports WHERE id = ?', [
          'export-retry',
        ]),
      ).toEqual({ status: 'ready', storage_key: key });
    } finally {
      deletion.mockRestore();
    }
    expect((await maintenance().runOnce()).exportsExpired).toBe(1);
    expect(await harness.storage.exists(key)).toBe(false);
  });

  it('serializes an expiry update behind file deletion and the expired transition', async () => {
    const account = await registerAccount(harness, { email: 'serialized-export@example.com' });
    const key = `org/${account.organisationId}/exports/serialized.csv`;
    await harness.storage.put(key, Buffer.from('private'));
    await harness.db.execute(
      `INSERT INTO exports (id, organisation_id, requested_by, format, filter, storage_key, status, expires_at, created_at)
       VALUES (?, ?, ?, 'csv', '{}', ?, 'ready', ?, ?)`,
      [
        'serialized-export',
        account.organisationId,
        account.userId,
        key,
        '2000-01-01T00:00:00.000Z',
        '2000-01-01T00:00:00.000Z',
      ],
    );
    let release!: () => void;
    let started!: () => void;
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    const entered = new Promise<void>((resolve) => {
      started = resolve;
    });
    const original = harness.storage.delete.bind(harness.storage);
    const deletion = jest
      .spyOn(harness.storage, 'delete')
      .mockImplementationOnce(async (selectedKey) => {
        started();
        await barrier;
        await original(selectedKey);
      });
    let sweep: ReturnType<MaintenanceService['runOnce']> | undefined;
    let competingSweep: ReturnType<MaintenanceService['runOnce']> | undefined;
    let extension: Promise<unknown> | undefined;
    try {
      sweep = maintenance().runOnce();
      await entered;
      competingSweep = maintenance().runOnce();
      extension = harness.db.one(
        "UPDATE exports SET expires_at = ? WHERE id = ? AND status = 'ready' RETURNING id",
        ['2999-01-01T00:00:00.000Z', 'serialized-export'],
      );
      release();
      expect((await sweep).exportsExpired).toBe(1);
      expect((await competingSweep).exportsExpired).toBe(0);
      expect(deletion).toHaveBeenCalledTimes(1);
      expect(await extension).toBeNull();
      expect(await harness.storage.exists(key)).toBe(false);
      expect(
        await harness.db.one('SELECT status, storage_key FROM exports WHERE id = ?', [
          'serialized-export',
        ]),
      ).toEqual({ status: 'expired', storage_key: null });
    } finally {
      release();
      if (sweep) await sweep.catch(() => undefined);
      if (competingSweep) await competingSweep.catch(() => undefined);
      if (extension) await extension.catch(() => undefined);
      deletion.mockRestore();
    }
  });

  it('leaves a live export alone', async () => {
    const account = await registerAccount(harness, { email: 'live-export@example.com' });
    const key = `org/${account.organisationId}/exports/live.csv`;
    await harness.storage.put(key, Buffer.from('a\n1\n'));
    await harness.db.execute(
      `INSERT INTO exports (id, organisation_id, requested_by, format, filter, row_count, storage_key, status, expires_at, created_at)
       VALUES (?, ?, ?, 'csv', '{}', 1, ?, 'ready', ?, ?)`,
      [
        'export-live',
        account.organisationId,
        account.userId,
        key,
        new Date(Date.now() + 86_400_000).toISOString(),
        new Date().toISOString(),
      ],
    );

    const report = await maintenance().runOnce();
    expect(report.exportsExpired).toBe(0);
    expect(await harness.storage.exists(key)).toBe(true);
  });

  it('expires abandoned pairing codes and deletes long-dead sessions', async () => {
    const account = await registerAccount(harness, { email: 'housekeeping@example.com' });

    await harness.db.execute(
      `INSERT INTO pairing_sessions (id, organisation_id, created_by, token_hash, status, expires_at, created_at)
       VALUES ('pair-old', ?, ?, 'hash-old', 'pending', ?, ?)`,
      [
        account.organisationId,
        account.userId,
        new Date(Date.now() - 60_000).toISOString(),
        new Date(Date.now() - 3_600_000).toISOString(),
      ],
    );
    await harness.db.execute('UPDATE sessions SET expires_at = ? WHERE user_id = ?', [
      new Date(Date.now() - 40 * 86_400_000).toISOString(),
      account.userId,
    ]);

    const report = await maintenance().runOnce();
    expect(report.pairingSessionsExpired).toBe(1);
    expect(report.sessionsDeleted).toBe(1);

    const pairing = await harness.db.one<{ status: string }>(
      'SELECT status FROM pairing_sessions WHERE id = ?',
      ['pair-old'],
    );
    expect(pairing?.status).toBe('expired');
    expect(
      await harness.db.query('SELECT id FROM sessions WHERE user_id = ?', [account.userId]),
    ).toHaveLength(0);
  });

  it('deletes only used reset tokens older than the seven-day cutoff', async () => {
    const account = await registerAccount(harness, { email: 'reset-retention@example.com' });
    const now = new Date('2026-10-10T12:00:00.000Z');
    const cutoff = new Date(now.getTime() - 7 * 86_400_000).toISOString();
    const older = new Date(now.getTime() - 7 * 86_400_000 - 1).toISOString();
    const recent = new Date(now.getTime() - 86_400_000).toISOString();
    for (const [id, usedAt] of [
      ['old-used', older],
      ['at-cutoff', cutoff],
      ['recent-used', recent],
      ['unused', null],
    ] as const) {
      await harness.db.execute(
        `INSERT INTO password_resets (id, user_id, token_hash, expires_at, used_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [id, account.userId, `hash-${id}`, recent, usedAt, older],
      );
    }

    expect((await maintenance().runOnce(now)).resetTokensDeleted).toBe(1);
    const remaining = await harness.db.query<{ id: string }>(
      'SELECT id FROM password_resets WHERE user_id = ? ORDER BY id',
      [account.userId],
    );
    expect(remaining.map((row) => row.id)).toEqual(['at-cutoff', 'recent-used', 'unused']);
    expect((await maintenance().runOnce(now)).resetTokensDeleted).toBe(0);
  });

  it('schedules itself only when enabled', async () => {
    expect(maintenance().isScheduled).toBe(false);
    maintenance().start(1);
    expect(maintenance().isScheduled).toBe(true);
    await maintenance().stop();
    expect(maintenance().isScheduled).toBe(false);
  });
});
