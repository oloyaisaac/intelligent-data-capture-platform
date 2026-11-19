import { createHarness, registerAccount, type Harness } from './helpers';
import { RECOVERY_GRACE_MS } from '../src/services/worker';
import { JobsRepository } from '../src/repositories/system-repo';

/**
 * Stale job recovery (DEC-029).
 *
 * Startup recovery requeues claims older than its grace period. It can reclaim a live job and it
 * does not revisit fresh claims later. Attempt guards protect the job row from stale completion,
 * but they do not fence extraction writes or prevent duplicate execution.
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

  it('documents that another worker can reclaim an active job older than the grace period', async () => {
    const account = await registerAccount(harness);
    // Model a still-running worker holding an old job: there is no ownership or heartbeat field.
    const active = await insertJob({
      organisationId: account.organisationId,
      status: 'running',
      startedAt: new Date(Date.now() - RECOVERY_GRACE_MS - 1000).toISOString(),
    });
    await harness.services.worker.start();
    await harness.services.worker.stop();
    expect(await statusOf(active)).toBe('queued');
    const reclaimed = await new JobsRepository(harness.db).claimNext();
    expect(reclaimed?.id).toBe(active);
    expect(reclaimed?.status).toBe('running');
    expect(reclaimed?.attempts).toBe(2);
  });

  it('rejects completion and failure reports from an old claim after recovery or reclaim', async () => {
    const account = await registerAccount(harness);
    const id = await insertJob({
      organisationId: account.organisationId,
      status: 'running',
      startedAt: new Date(Date.now() - 10 * 60_000).toISOString(),
      attempts: 1,
    });
    const repository = new JobsRepository(harness.db);
    expect(
      await repository.requeueStale(new Date(Date.now() - RECOVERY_GRACE_MS).toISOString()),
    ).toBe(1);

    // A stale worker cannot finish while recovery has left its claim queued.
    expect(await repository.markSucceeded(id, 1)).toBe(false);
    expect(await repository.markFailed(id, 1, 'stale failure')).toBeNull();
    expect(await statusOf(id)).toBe('queued');

    const current = await repository.claimNext();
    expect(current?.id).toBe(id);
    expect(current?.attempts).toBe(2);
    expect(await repository.markSucceeded(id, 1)).toBe(false);
    expect(await repository.markFailed(id, 1, 'stale failure')).toBeNull();
    expect(await statusOf(id)).toBe('running');
    expect(await repository.markSucceeded(id, 2)).toBe(true);
    expect(await statusOf(id)).toBe('succeeded');
    expect(await repository.markFailed(id, 2, 'late failure')).toBeNull();
    expect(await statusOf(id)).toBe('succeeded');
  });

  it('rejects failure if recovery changes the row between its read and update', async () => {
    const account = await registerAccount(harness);
    const id = await insertJob({
      organisationId: account.organisationId,
      status: 'running',
      startedAt: new Date(Date.now() - 10 * 60_000).toISOString(),
      attempts: 1,
    });
    const repository = new JobsRepository(harness.db);
    const original = harness.db.one.bind(harness.db);
    const select = jest.spyOn(harness.db, 'one').mockImplementationOnce(async (sql, params) => {
      const row = await original(sql, params);
      await repository.requeueStale(new Date(Date.now() - RECOVERY_GRACE_MS).toISOString());
      return row as never;
    });
    try {
      expect(await repository.markFailed(id, 1, 'late failure')).toBeNull();
      expect(await statusOf(id)).toBe('queued');
      const claimed = await repository.claimNext();
      expect(claimed?.attempts).toBe(2);
      expect(await repository.markSucceeded(id, 2)).toBe(true);
    } finally {
      select.mockRestore();
    }
  });

  it('accepts failure only from the current running attempt and preserves terminal states', async () => {
    const account = await registerAccount(harness);
    const id = await insertJob({
      organisationId: account.organisationId,
      status: 'running',
      startedAt: new Date().toISOString(),
      attempts: 5,
    });
    const repository = new JobsRepository(harness.db);
    expect(await repository.markFailed(id, 5, 'failure')).toBe('dead');
    expect(await statusOf(id)).toBe('dead');
    expect(await repository.markSucceeded(id, 5)).toBe(false);
    expect(await repository.markFailed(id, 5, 'duplicate')).toBeNull();
    const row = await harness.db.one<{ last_error: string }>(
      'SELECT last_error FROM jobs WHERE id = ?',
      [id],
    );
    expect(row?.last_error).toBe('failure');
  });

  it('still duplicates extraction side effects when a live claim is recovered', async () => {
    const account = await registerAccount(harness);
    const upload = await harness.api.upload(account.accessToken);
    expect(upload.statusCode).toBe(201);
    const documentId = upload.json<{ id: string }>().id;
    const repository = new JobsRepository(harness.db);
    let resume!: () => void;
    let entered!: () => void;
    const paused = new Promise<void>((resolve) => {
      resume = resolve;
    });
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const originalOcr = harness.ocr.ocr.bind(harness.ocr);
    const ocr = jest.spyOn(harness.ocr, 'ocr').mockImplementationOnce(async () => {
      entered();
      await paused;
      return originalOcr();
    });
    let first: Promise<number> | undefined;
    try {
      first = harness.services.worker.drain();
      await started;
      const old = (await repository.listForDocument(documentId))[0]!;
      expect(old.attempts).toBe(1);
      // Model a second process starting after this live claim is considered stale. Its recovery
      // and processing use the real repository and worker, with deterministic fake OCR.
      expect(await repository.requeueStale(new Date(Date.now() + 1000).toISOString())).toBe(1);
      const second = await repository.claimNext();
      expect(second?.id).toBe(old.id);
      expect(second?.attempts).toBe(2);
      await harness.services.worker.processJob(second!);
      resume();
      await first;
      const rows = await harness.db.query<{ id: string }>(
        'SELECT id FROM extractions WHERE document_id = ?',
        [documentId],
      );
      expect(harness.ocr.calls).toBe(2);
      expect(rows).toHaveLength(2);
      expect(await statusOf(old.id)).toBe('succeeded');
    } finally {
      resume();
      if (first) await first.catch(() => undefined);
      ocr.mockRestore();
    }
  });

  it('reports only rows actually requeued by competing recovery calls', async () => {
    const account = await registerAccount(harness);
    const stale = await insertJob({
      organisationId: account.organisationId,
      status: 'running',
      startedAt: new Date(Date.now() - 10 * 60_000).toISOString(),
    });
    const cutoff = new Date(Date.now() - RECOVERY_GRACE_MS).toISOString();
    const repository = new JobsRepository(harness.db);
    const counts = await Promise.all([
      repository.requeueStale(cutoff),
      repository.requeueStale(cutoff),
    ]);
    expect(counts.sort()).toEqual([0, 1]);
    expect(await statusOf(stale)).toBe('queued');
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
