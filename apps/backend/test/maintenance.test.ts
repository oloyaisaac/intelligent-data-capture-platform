import { createHarness, registerAccount, type Harness } from './helpers';

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
    harness.services.maintenance.stop();
    await harness.close();
  });

  const maintenance = () => harness.services.maintenance;

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

  it('schedules itself only when enabled', () => {
    expect(maintenance().isScheduled).toBe(false);
    maintenance().start(1);
    expect(maintenance().isScheduled).toBe(true);
    maintenance().stop();
    expect(maintenance().isScheduled).toBe(false);
  });
});
