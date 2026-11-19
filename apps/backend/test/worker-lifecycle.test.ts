import { createLogger } from '../src/logger';
import { MemoryStorage } from '../src/storage';
import { InMemoryRealtimeHub } from '../src/realtime/hub';
import { Worker, type WorkerRepositories } from '../src/services/worker';
import type { JobRow } from '../src/repositories/types';
import { FakeOcrProvider, testConfig } from './helpers';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}

function job(id: string): JobRow {
  return {
    id,
    organisation_id: 'org',
    type: 'retention_purge',
    document_id: null,
    payload: '{}',
    status: 'running',
    attempts: 1,
    max_attempts: 5,
    last_error: null,
    run_after: null,
    started_at: null,
    finished_at: null,
    created_at: '2026-01-01T00:00:00.000Z',
  };
}

function setup() {
  const jobs = {
    claimNext: jest.fn<Promise<JobRow | null>, []>(),
    requeueStale: jest.fn().mockResolvedValue(0),
    markSucceeded: jest.fn().mockResolvedValue(true),
    markFailed: jest.fn().mockResolvedValue('queued'),
  };
  const repositories: WorkerRepositories = {
    jobs,
    documents: { findById: jest.fn(), updateStatus: jest.fn() },
    extractions: { create: jest.fn(), replaceFields: jest.fn() },
    pages: { upsertOcr: jest.fn() },
    orgs: { findById: jest.fn().mockResolvedValue({ retention_days: 30 }) },
  };
  const purge = jest.fn<Promise<number>, [string, number]>().mockResolvedValue(0);
  const worker = new Worker(
    repositories,
    testConfig(),
    new MemoryStorage(),
    new FakeOcrProvider(),
    new InMemoryRealtimeHub(),
    { purgeExpired: purge },
    createLogger({ level: 'error', sink: () => undefined }),
  );
  return { worker, jobs, purge };
}

it('waits for active work on stop, coalesces concurrent drains, and leaves later jobs unclaimed', async () => {
  const { worker, jobs, purge } = setup();
  const begun = deferred<void>();
  const finish = deferred<number>();
  jobs.claimNext
    .mockResolvedValueOnce(job('first'))
    .mockResolvedValueOnce(job('second'))
    .mockResolvedValue(null);
  purge.mockImplementationOnce(() => {
    begun.resolve();
    return finish.promise;
  });
  const firstDrain = worker.drain();
  const secondDrain = worker.drain();
  await begun.promise;
  let stopped = false;
  const stopping = worker.stop().then(() => {
    stopped = true;
  });
  await Promise.resolve();
  expect(stopped).toBe(false);
  expect(jobs.claimNext).toHaveBeenCalledTimes(1);
  finish.resolve(1);
  expect(await firstDrain).toBe(1);
  expect(await secondDrain).toBe(1);
  await stopping;
  expect(stopped).toBe(true);
  expect(jobs.markSucceeded).toHaveBeenCalledTimes(1);
  expect(jobs.markSucceeded).toHaveBeenCalledWith('first', 1);
  expect(jobs.claimNext).toHaveBeenCalledTimes(1);
  expect(await worker.drain()).toBe(1);
  expect(jobs.markSucceeded).toHaveBeenCalledWith('second', 1);
});

it('finishes a job whose claim was already in flight when stop began', async () => {
  const { worker, jobs, purge } = setup();
  const claimed = deferred<JobRow | null>();
  jobs.claimNext.mockReturnValueOnce(claimed.promise);
  const draining = worker.drain();
  let stopped = false;
  const stopping = worker.stop().then(() => {
    stopped = true;
  });
  await Promise.resolve();
  expect(stopped).toBe(false);
  claimed.resolve(job('in-flight'));
  expect(await draining).toBe(1);
  await stopping;
  expect(purge).toHaveBeenCalledTimes(1);
  expect(jobs.markSucceeded).toHaveBeenCalledWith('in-flight', 1);
  expect(jobs.claimNext).toHaveBeenCalledTimes(1);
});

it('waits for recovery during stop and never starts a timer after shutdown', async () => {
  jest.useFakeTimers();
  const { worker, jobs } = setup();
  const recovery = deferred<number>();
  jobs.requeueStale.mockReturnValueOnce(recovery.promise);
  try {
    const starting = worker.start();
    let stopped = false;
    const stopping = worker.stop().then(() => {
      stopped = true;
    });
    await Promise.resolve();
    expect(stopped).toBe(false);
    recovery.resolve(0);
    await starting;
    await stopping;
    await jest.advanceTimersByTimeAsync(60_000);
    expect(jobs.claimNext).not.toHaveBeenCalled();
    expect(jest.getTimerCount()).toBe(0);
  } finally {
    await worker.stop();
    jest.useRealTimers();
  }
});

it('does not restart recovery until the previous stop has finished its active job', async () => {
  const { worker, jobs, purge } = setup();
  const begun = deferred<void>();
  const finish = deferred<number>();
  jobs.claimNext.mockResolvedValueOnce(job('active')).mockResolvedValue(null);
  purge.mockImplementationOnce(() => {
    begun.resolve();
    return finish.promise;
  });
  const draining = worker.drain();
  await begun.promise;
  const stopping = worker.stop();
  const restarting = worker.start();
  await Promise.resolve();
  expect(jobs.requeueStale).not.toHaveBeenCalled();
  finish.resolve(0);
  await draining;
  await stopping;
  await restarting;
  expect(jobs.markSucceeded).toHaveBeenCalledWith('active', 1);
  expect(jobs.requeueStale).toHaveBeenCalledTimes(1);
  await worker.stop();
});

it('does not fail a document or emit a failure event when the job claim is obsolete', async () => {
  const jobs = {
    claimNext: jest.fn(),
    requeueStale: jest.fn(),
    markSucceeded: jest.fn(),
    markFailed: jest.fn().mockResolvedValue(null),
  };
  const documents = {
    findById: jest.fn().mockRejectedValue(new Error('ocr failed')),
    updateStatus: jest.fn(),
  };
  const hub = new InMemoryRealtimeHub();
  const emit = jest.spyOn(hub, 'toOrganisation');
  const worker = new Worker(
    {
      jobs,
      documents,
      extractions: { create: jest.fn(), replaceFields: jest.fn() },
      pages: { upsertOcr: jest.fn() },
      orgs: { findById: jest.fn() },
    },
    testConfig(),
    new MemoryStorage(),
    new FakeOcrProvider(),
    hub,
    { purgeExpired: jest.fn() },
    createLogger({ level: 'error', sink: () => undefined }),
  );
  await worker.processJob({ ...job('obsolete'), type: 'extract_document', document_id: 'doc' });
  expect(jobs.markFailed).toHaveBeenCalledWith('obsolete', 1, 'ocr failed');
  expect(documents.updateStatus).not.toHaveBeenCalled();
  expect(emit).not.toHaveBeenCalled();
});

it('waits for a failed drain without preventing shutdown cleanup', async () => {
  const { worker, jobs } = setup();
  const claim = deferred<JobRow | null>();
  jobs.claimNext.mockReturnValueOnce(claim.promise);
  const draining = worker.drain();
  // Attach a rejection handler before rejecting to avoid an unhandled rejection in the test.
  const failed = expect(draining).rejects.toThrow('claim unavailable');
  const stopping = worker.stop();
  claim.reject(new Error('claim unavailable'));
  await failed;
  await expect(stopping).resolves.toBeUndefined();
});

it('allows startup to be retried after recovery fails', async () => {
  const { worker, jobs } = setup();
  jobs.requeueStale.mockRejectedValueOnce(new Error('database unavailable'));
  await expect(worker.start()).rejects.toThrow('database unavailable');
  await worker.start();
  expect(jobs.requeueStale).toHaveBeenCalledTimes(2);
  await worker.stop();
});
