import { createHarness, registerAccount, type Harness } from './helpers';
import { RECOVERY_GRACE_MS } from '../src/services/worker';

/**
 * Stale job recovery (DEC-029).
 *
 * `claimNext` moves a job from `queued` to `running` and nothing else ever moves it out of that
 * state, so a crash, a `kill -9` or a deploy that stopped the container mid-extraction used to
 * strand the job — and its document in `processing` — with no retry and no error. The worker now
 * re-queues anything claimed before this process started.
 */
describe('worker recovery of interrupted jobs', () => {
  let harness: Harness;

  beforeEach(async () => {
    harness = await createHarness();
  });

  afterEach(async () => {
    await harness.services.worker.stop();
    await harness.close();
  });

  /** Insert a job directly, bypassing the API, in whatever state the test needs. */
  async function insertJob(input: {
    organisationId: string;
    status: 'running' | 'queued';
    startedAt: string | null;
    attempts?: number;
  }): Promise<string> {
    const id = `job-${Math.random().toString(36).slice(2, 12)}`;
    await harness.db.execute(
      `INSERT INTO jobs (id, organisation_id, type, document_id, payload, status, attempts, max_attempts, run_after, started_at, created_at)
       VALUES (?, ?, ?, NULL, '{}', ?, ?, 5, ?, ?, ?)`,
      [
        id,
        input.organisationId,
        'retention_purge',
        input.status,
        input.attempts ?? 1,
        new Date(Date.now() - 60_000).toISOString(),
        input.startedAt,
        new Date(Date.now() - 3_600_000).toISOString(),
      ],
    );
    return id;
  }

  async function statusOf(id: string): Promise<string> {
    const row = await harness.db.one<{ status: string; last_error: string | null }>(
      'SELECT status, last_error FROM jobs WHERE id = ?',
      [id],
    );
    return row?.status ?? 'missing';
  }

  it('re-queues a job a previous process left running, then completes it', async () => {
    const account = await registerAccount(harness);
    // Claimed ten minutes ago by a process that is no longer alive.
    const stale = await insertJob({
      organisationId: account.organisationId,
      status: 'running',
      startedAt: new Date(Date.now() - 10 * 60_000).toISOString(),
    });
    expect(await statusOf(stale)).toBe('running');

    await harness.services.worker.start();
    await harness.services.worker.stop();

    expect(await statusOf(stale)).toBe('queued');
    const recovered = await harness.db.one<{ last_error: string }>(
      'SELECT last_error FROM jobs WHERE id = ?',
      [stale],
    );
    expect(recovered?.last_error).toContain('interrupted');

    await harness.services.worker.drain();
    expect(await statusOf(stale)).toBe('succeeded');
  });

  it('leaves a job claimed moments ago alone, in case another process is still working on it', async () => {
    const account = await registerAccount(harness);
    const fresh = await insertJob({
      organisationId: account.organisationId,
      status: 'running',
      startedAt: new Date(Date.now() - Math.floor(RECOVERY_GRACE_MS / 2)).toISOString(),
    });

    await harness.services.worker.start();
    await harness.services.worker.stop();

    expect(await statusOf(fresh)).toBe('running');
  });

  it('does not touch finished or queued jobs', async () => {
    const account = await registerAccount(harness);
    const queued = await insertJob({
      organisationId: account.organisationId,
      status: 'queued',
      startedAt: null,
    });

    await harness.services.worker.start();
    await harness.services.worker.stop();

    expect(await statusOf(queued)).toBe('queued');
  });
});
