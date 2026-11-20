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

function setup(logs: string[] = []) {
  const jobs = {
    claimNext: jest.fn<Promise<JobRow | null>, []>(),
    countRunning: jest.fn().mockResolvedValue(0),
    markSucceeded: jest.fn().mockResolvedValue(true),
    markFailed: jest.fn().mockResolvedValue('queued'),
  };
  const repositories: WorkerRepositories = {
    jobs,
    orgs: { findById: jest.fn().mockResolvedValue({ retention_days: 30 }) },
    transaction: jest.fn(),
  };
  const purge = jest.fn<Promise<number>, [string, number]>().mockResolvedValue(0);
  const worker = new Worker(
    repositories,
    testConfig(),
    new MemoryStorage(),
    new FakeOcrProvider(),
    new InMemoryRealtimeHub(),
    { purgeExpired: purge },
    createLogger({ level: 'debug', sink: (line) => logs.push(line) }),
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

it('waits for the startup check during stop and never starts a timer after shutdown', async () => {
  jest.useFakeTimers();
  const { worker, jobs } = setup();
  const recovery = deferred<number>();
  jobs.countRunning.mockReturnValueOnce(recovery.promise);
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

it('does not restart the startup check until the previous stop has finished its active job', async () => {
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
  expect(jobs.countRunning).not.toHaveBeenCalled();
  finish.resolve(0);
  await draining;
  await stopping;
  await restarting;
  expect(jobs.markSucceeded).toHaveBeenCalledWith('active', 1);
  expect(jobs.countRunning).toHaveBeenCalledTimes(1);
  await worker.stop();
});

it('does not fail a document or emit a failure event when the job claim is obsolete', async () => {
  const jobs = {
    claimNext: jest.fn(),
    countRunning: jest.fn(),
    markSucceeded: jest.fn(),
    markFailed: jest.fn().mockResolvedValue(null),
  };
  const documents = { failProcessing: jest.fn() };
  const hub = new InMemoryRealtimeHub();
  const emit = jest.spyOn(hub, 'toOrganisation');
  const worker = new Worker(
    {
      jobs,
      orgs: { findById: jest.fn() },
      transaction: jest
        .fn()
        .mockRejectedValueOnce(new Error('ocr failed'))
        .mockImplementation(async (run) => run({ jobs, documents })),
    },
    testConfig(),
    new MemoryStorage(),
    new FakeOcrProvider(),
    hub,
    { purgeExpired: jest.fn() },
    createLogger({ level: 'error', sink: () => undefined }),
  );
  await worker.processJob({ ...job('obsolete'), type: 'extract_document', document_id: 'doc' });
  expect(jobs.markFailed).toHaveBeenCalledWith(
    'obsolete',
    1,
    'Document extraction failed. Investigate the worker and retry.',
  );
  expect(documents.failProcessing).not.toHaveBeenCalled();
  expect(emit).not.toHaveBeenCalled();
});

it('waits for a failed drain without preventing shutdown cleanup or logging exception text', async () => {
  const logs: string[] = [];
  const { worker, jobs } = setup(logs);
  const claim = deferred<JobRow | null>();
  jobs.claimNext.mockReturnValueOnce(claim.promise);
  const draining = worker.drain();
  // Attach a rejection handler before rejecting to avoid an unhandled rejection in the test.
  const failed = expect(draining).rejects.toThrow('claim unavailable');
  const stopping = worker.stop();
  claim.reject(new Error('claim unavailable'));
  await failed;
  await expect(stopping).resolves.toBeUndefined();
  expect(logs.join('\n')).toContain('worker drain failed during shutdown');
  expect(logs.join('\n')).not.toContain('claim unavailable');
});

it('logs no exception details from failed ticks', async () => {
  jest.useFakeTimers();
  const logs: string[] = [];
  const { worker, jobs } = setup(logs);
  jobs.claimNext.mockRejectedValue(new Error('SECRET-TICK'));
  try {
    await worker.start();
    await jest.advanceTimersByTimeAsync(30_000);
    expect(logs.join('\n')).toContain('worker tick failed');
    expect(logs.join('\n')).not.toContain('SECRET-TICK');
  } finally {
    await worker.stop();
    jest.useRealTimers();
  }
});

it('persists only safe guidance for retention and unknown job failures', async () => {
  const logs: string[] = [];
  const { worker, jobs, purge } = setup(logs);
  purge.mockRejectedValueOnce(new Error('SECRET-RETENTION'));
  await worker.processJob(job('retention'));
  await worker.processJob({ ...job('unknown'), type: 'SECRET-UNKNOWN' });
  expect(jobs.markFailed).toHaveBeenNthCalledWith(
    1,
    'retention',
    1,
    'Retention purge failed. Investigate storage and retry.',
  );
  expect(jobs.markFailed).toHaveBeenNthCalledWith(
    2,
    'unknown',
    1,
    'Job failed. Investigate the job type.',
  );
  expect(logs.join('\n')).not.toContain('SECRET-');
});

it('allows startup to be retried after the check fails', async () => {
  const { worker, jobs } = setup();
  jobs.countRunning.mockRejectedValueOnce(new Error('database unavailable'));
  await expect(worker.start()).rejects.toThrow('database unavailable');
  await worker.start();
  expect(jobs.countRunning).toHaveBeenCalledTimes(2);
  await worker.stop();
});
