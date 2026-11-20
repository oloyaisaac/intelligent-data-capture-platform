import { createHarness, registerAccount, type Harness } from './helpers';
import { JobsRepository } from '../src/repositories/system-repo';

describe('retention purge scheduling', () => {
  let harness: Harness;
  beforeEach(async () => {
    harness = await createHarness();
  });
  afterEach(async () => {
    await harness.close();
  });

  it('does not claim two existing purge jobs for the same organisation concurrently', async () => {
    const account = await registerAccount(harness);
    const jobs = new JobsRepository(harness.db);
    const first = await jobs.enqueue({
      organisationId: account.organisationId,
      type: 'retention_purge',
    });
    const second = await jobs.enqueue({
      organisationId: account.organisationId,
      type: 'retention_purge',
    });
    const running = await jobs.claimNext();
    expect([first.id, second.id]).toContain(running?.id);
    expect(await jobs.claimNext()).toBeNull();
    const waiting = await jobs.findById(running!.id === first.id ? second.id : first.id);
    expect(waiting?.status).toBe('queued');
    expect(waiting?.attempts).toBe(0);
    expect(await jobs.markSucceeded(running!.id, running!.attempts)).toBe(true);
    expect((await jobs.claimNext())?.id).toBe(waiting!.id);
  });

  it('rechecks the retention policy before scheduling but permits an explicit manual request', async () => {
    const account = await registerAccount(harness);
    await harness.db.execute('UPDATE organisations SET retention_days = 0 WHERE id = ?', [
      account.organisationId,
    ]);
    const jobs = new JobsRepository(harness.db);
    expect(
      await jobs.enqueueRetentionIfAbsent({
        organisationId: account.organisationId,
        onlyEnabled: true,
      }),
    ).toEqual({ job: null, created: false });
    const manual = await harness.api.json('POST', '/api/v1/retention/purge', {
      token: account.accessToken,
    });
    expect(manual.statusCode).toBe(202);
    expect(manual.json<{ jobId: string }>().jobId).toBeTruthy();
  });

  it('returns the same active purge for concurrent manual requests', async () => {
    const account = await registerAccount(harness);
    const results = await Promise.all([
      harness.api.json('POST', '/api/v1/retention/purge', { token: account.accessToken }),
      harness.api.json('POST', '/api/v1/retention/purge', { token: account.accessToken }),
    ]);
    expect(results.map((response) => response.statusCode)).toEqual([202, 202]);
    expect(results[0]!.json<{ jobId: string }>().jobId).toBe(
      results[1]!.json<{ jobId: string }>().jobId,
    );
    const rows = await harness.db.query(
      'SELECT id FROM jobs WHERE organisation_id = ? AND type = ? AND status IN (?, ?)',
      [account.organisationId, 'retention_purge', 'queued', 'running'],
    );
    expect(rows).toHaveLength(1);
  });

  it('does not enqueue separate jobs when the scheduler and a manual request overlap', async () => {
    const account = await registerAccount(harness);
    const [, manual] = await Promise.all([
      harness.services.maintenance.runOnce(),
      harness.api.json('POST', '/api/v1/retention/purge', { token: account.accessToken }),
    ]);
    expect(manual.statusCode).toBe(202);
    const rows = await harness.db.query<{ id: string }>(
      'SELECT id FROM jobs WHERE organisation_id = ? AND type = ? AND status IN (?, ?)',
      [account.organisationId, 'retention_purge', 'queued', 'running'],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toBe(manual.json<{ jobId: string }>().jobId);
  });
});
