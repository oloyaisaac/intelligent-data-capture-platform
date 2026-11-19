import { createHarness, registerAccount, type Harness } from './helpers';
import { RECOVERY_GRACE_MS } from '../src/services/worker';
import { JobsRepository } from '../src/repositories/system-repo';
import { ExtractionsRepository } from '../src/repositories/document-repo';

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

  it('does not commit an obsolete extraction after a live claim is recovered', async () => {
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
      // OCR itself remains at-least-once, but only the current attempt may publish results.
      expect(harness.ocr.calls).toBe(2);
      expect(rows).toHaveLength(1);
      expect(await statusOf(old.id)).toBe('succeeded');
    } finally {
      resume();
      if (first) await first.catch(() => undefined);
      ocr.mockRestore();
    }
  });

  it('rejects reprocessing while an extraction is running', async () => {
    const account = await registerAccount(harness);
    const upload = await harness.api.upload(account.accessToken);
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
    let work: Promise<number> | undefined;
    try {
      work = harness.services.worker.drain();
      await started;
      const reprocess = await harness.api.json(
        'POST',
        `/api/v1/documents/${documentId}/reprocess`,
        { token: account.accessToken },
      );
      expect(reprocess.statusCode).toBe(409);
      expect(await repository.listForDocument(documentId)).toHaveLength(1);
      resume();
      await work;
      expect(
        await harness.db.query('SELECT id FROM extractions WHERE document_id = ?', [documentId]),
      ).toHaveLength(1);
    } finally {
      resume();
      if (work) await work.catch(() => undefined);
      ocr.mockRestore();
    }
  });

  it('rolls back the entire extraction publication when a field write fails, then retries', async () => {
    const account = await registerAccount(harness);
    const upload = await harness.api.upload(account.accessToken);
    const documentId = upload.json<{ id: string }>().id;
    const fail = jest
      .spyOn(ExtractionsRepository.prototype, 'replaceFields')
      .mockRejectedValueOnce(new Error('field write failed'));
    try {
      await harness.services.worker.drain();
    } finally {
      fail.mockRestore();
    }
    const repository = new JobsRepository(harness.db);
    const job = (await repository.listForDocument(documentId))[0]!;
    expect(job.status).toBe('queued');
    expect(job.last_error).toBe('field write failed');
    expect(
      await harness.db.query('SELECT id FROM extractions WHERE document_id = ?', [documentId]),
    ).toHaveLength(0);
    const page = await harness.db.one<{ ocr_text: string | null }>(
      'SELECT ocr_text FROM document_pages WHERE document_id = ?',
      [documentId],
    );
    expect(page?.ocr_text).toBeNull();
    const document = await harness.db.one<{ status: string }>(
      'SELECT status FROM documents WHERE id = ?',
      [documentId],
    );
    expect(document?.status).toBe('processing');

    await harness.db.execute('UPDATE jobs SET run_after = ? WHERE id = ?', [
      new Date(0).toISOString(),
      job.id,
    ]);
    await harness.services.worker.drain();
    expect(await statusOf(job.id)).toBe('succeeded');
    expect(
      await harness.db.query('SELECT id FROM extractions WHERE document_id = ?', [documentId]),
    ).toHaveLength(1);
  });

  it('does not resurrect a document deleted while OCR is running', async () => {
    const account = await registerAccount(harness);
    const upload = await harness.api.upload(account.accessToken);
    const documentId = upload.json<{ id: string }>().id;
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
    const events: string[] = [];
    const unsubscribe = harness.hub.subscribe({ organisationId: account.organisationId }, (event) =>
      events.push(event),
    );
    let running: Promise<number> | undefined;
    try {
      running = harness.services.worker.drain();
      await started;
      const deleted = await harness.api.json('DELETE', `/api/v1/documents/${documentId}`, {
        token: account.accessToken,
      });
      expect(deleted.statusCode).toBe(204);
      resume();
      await running;
      const row = await harness.db.one<{ status: string; deleted_at: string | null }>(
        'SELECT status, deleted_at FROM documents WHERE id = ?',
        [documentId],
      );
      expect(row?.status).toBe('deleted');
      expect(row?.deleted_at).not.toBeNull();
      expect(
        await harness.db.query('SELECT id FROM extractions WHERE document_id = ?', [documentId]),
      ).toHaveLength(0);
      expect(events).not.toContain('document:extracted');
    } finally {
      resume();
      if (running) await running.catch(() => undefined);
      unsubscribe();
      ocr.mockRestore();
    }
  });

  it('does not replace a deletion with failed status after the final OCR attempt errors', async () => {
    const account = await registerAccount(harness);
    const upload = await harness.api.upload(account.accessToken);
    const documentId = upload.json<{ id: string }>().id;
    const repository = new JobsRepository(harness.db);
    const job = (await repository.listForDocument(documentId))[0]!;
    await harness.db.execute('UPDATE jobs SET attempts = 4 WHERE id = ?', [job.id]);
    let resume!: () => void;
    let entered!: () => void;
    const paused = new Promise<void>((resolve) => {
      resume = resolve;
    });
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const ocr = jest.spyOn(harness.ocr, 'ocr').mockImplementationOnce(async () => {
      entered();
      await paused;
      throw new Error('synthetic OCR failure');
    });
    const events: string[] = [];
    const unsubscribe = harness.hub.subscribe({ organisationId: account.organisationId }, (event) =>
      events.push(event),
    );
    let running: Promise<number> | undefined;
    try {
      running = harness.services.worker.drain();
      await started;
      const deleted = await harness.api.json('DELETE', `/api/v1/documents/${documentId}`, {
        token: account.accessToken,
      });
      expect(deleted.statusCode).toBe(204);
      resume();
      await running;
      expect(await statusOf(job.id)).toBe('dead');
      const row = await harness.db.one<{ status: string; deleted_at: string | null }>(
        'SELECT status, deleted_at FROM documents WHERE id = ?',
        [documentId],
      );
      expect(row?.status).toBe('deleted');
      expect(row?.deleted_at).not.toBeNull();
      expect(events).not.toContain('document:failed');
    } finally {
      resume();
      if (running) await running.catch(() => undefined);
      unsubscribe();
      ocr.mockRestore();
    }
  });

  it('serializes a recovery update against a transaction finalizing the same claim', async () => {
    const account = await registerAccount(harness);
    const id = await insertJob({
      organisationId: account.organisationId,
      status: 'running',
      startedAt: new Date(Date.now() - 60_000).toISOString(),
    });
    let release!: () => void;
    let locked!: () => void;
    const wait = new Promise<void>((resolve) => {
      release = resolve;
    });
    const ready = new Promise<void>((resolve) => {
      locked = resolve;
    });
    let recovered: Promise<number> | undefined;
    const finishing = harness.db.transaction(async (tx) => {
      expect(await new JobsRepository(tx).markSucceeded(id, 1)).toBe(true);
      locked();
      await wait;
    });
    try {
      await ready;
      let settled = false;
      recovered = new JobsRepository(harness.db)
        .requeueStale(new Date().toISOString())
        .then((count) => {
          settled = true;
          return count;
        });
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(settled).toBe(false);
      release();
      await finishing;
      expect(await recovered).toBe(0);
      expect(await statusOf(id)).toBe('succeeded');
    } finally {
      release();
      await finishing.catch(() => undefined);
      if (recovered) await recovered.catch(() => undefined);
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
