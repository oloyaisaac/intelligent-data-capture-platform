import type { Database } from '../src/db/database';
import { JobsRepository } from '../src/repositories/system-repo';
import { WorkerRecoveryRepository } from '../src/repositories/worker-recovery-repo';
import { createHarness, registerAccount } from './helpers';

const input = (id: string, attempt = 1) => ({
  id,
  attempt,
  operatorReference: 'operator-test',
  incidentReference: 'INC-42',
});

it.each(['queued', 'processing'] as const)(
  'abandons an interrupted extraction and marks its isolated %s document failed',
  async (status) => {
    const harness = await createHarness();
    try {
      const account = await registerAccount(harness);
      const upload = await harness.api.upload(account.accessToken);
      const documentId = upload.json<{ id: string }>().id;
      const jobs = new JobsRepository(harness.db);
      const claimed = await jobs.claimNext();
      expect(claimed?.document_id).toBe(documentId);
      await harness.db.execute('UPDATE documents SET status = ? WHERE id = ?', [
        status,
        documentId,
      ]);
      const recovery = new WorkerRecoveryRepository(harness.db);
      const key = (await harness.db.one<{ storage_key: string }>(
        'SELECT storage_key FROM documents WHERE id = ?',
        [documentId],
      ))!.storage_key;
      const result = await recovery.abandonWithAudit(input(claimed!.id));
      expect(result).toEqual({ abandoned: true, documentFailed: true });
      expect(await jobs.findById(claimed!.id)).toMatchObject({
        status: 'dead',
        attempts: 1,
        run_after: null,
        last_error: 'Abandoned by operator after offline review; not retried.',
      });
      expect((await jobs.findById(claimed!.id))?.finished_at).toBeTruthy();
      expect(
        await harness.db.one('SELECT status, deleted_at FROM documents WHERE id = ?', [documentId]),
      ).toEqual({ status: 'failed', deleted_at: null });
      expect(await harness.storage.exists(key)).toBe(true);
      expect(await jobs.claimNext()).toBeNull();
      const audit = await harness.db.one<{
        actor_type: string;
        actor_id: string | null;
        metadata: string;
      }>(
        'SELECT actor_type, actor_id, metadata FROM audit_logs WHERE action = ? AND target_id = ?',
        ['worker.job_abandoned_offline', claimed!.id],
      );
      expect(audit).toMatchObject({ actor_type: 'system', actor_id: null });
      expect(JSON.parse(audit!.metadata)).toEqual({
        jobType: 'extract_document',
        attempt: 1,
        operatorReference: 'operator-test',
        incidentReference: 'INC-42',
        documentFailed: true,
      });
      expect(await recovery.abandonWithAudit(input(claimed!.id))).toEqual({
        abandoned: false,
        documentFailed: false,
      });
      expect(await recovery.requeueWithAudit(input(claimed!.id))).toBe(false);
      expect(
        await harness.db.query('SELECT id FROM audit_logs WHERE action = ? AND target_id = ?', [
          'worker.job_abandoned_offline',
          claimed!.id,
        ]),
      ).toHaveLength(1);
    } finally {
      await harness.close();
    }
  },
);

it.each(['other-job', 'deleted', 'extracted', 'missing'] as const)(
  'leaves the document unchanged or absent for ambiguous %s state',
  async (scenario) => {
    const harness = await createHarness();
    try {
      const account = await registerAccount(harness);
      const upload = await harness.api.upload(account.accessToken);
      const documentId = upload.json<{ id: string }>().id;
      const jobs = new JobsRepository(harness.db);
      const claimed = (await jobs.claimNext())!;
      if (scenario === 'other-job') {
        const other = await jobs.enqueue({
          organisationId: account.organisationId,
          documentId,
          type: 'extract_document',
        });
        await harness.db.execute("UPDATE jobs SET status = 'succeeded' WHERE id = ?", [other.id]);
      }
      if (scenario === 'deleted')
        await harness.db.execute(
          "UPDATE documents SET status = 'deleted', deleted_at = ? WHERE id = ?",
          ['2001-01-01T00:00:00.000Z', documentId],
        );
      if (scenario === 'extracted')
        await harness.db.execute("UPDATE documents SET status = 'extracted' WHERE id = ?", [
          documentId,
        ]);
      if (scenario === 'missing')
        await harness.db.execute("UPDATE jobs SET document_id = 'missing-document' WHERE id = ?", [
          claimed.id,
        ]);
      const before = await harness.db.one('SELECT status, deleted_at FROM documents WHERE id = ?', [
        documentId,
      ]);
      expect(
        await new WorkerRecoveryRepository(harness.db).abandonWithAudit(input(claimed.id)),
      ).toEqual({ abandoned: true, documentFailed: false });
      expect(
        await harness.db.one('SELECT status, deleted_at FROM documents WHERE id = ?', [documentId]),
      ).toEqual(before);
      expect((await jobs.findById(claimed.id))?.status).toBe('dead');
    } finally {
      await harness.close();
    }
  },
);

it('abandons only a matching running attempt of a known job type', async () => {
  const harness = await createHarness();
  try {
    const account = await registerAccount(harness);
    const jobs = new JobsRepository(harness.db);
    const first = await jobs.enqueue({
      organisationId: account.organisationId,
      type: 'retention_purge',
    });
    const unknown = await jobs.enqueue({
      organisationId: account.organisationId,
      type: 'future_job',
    });
    await harness.db.execute(
      "UPDATE jobs SET status = 'running', attempts = 1 WHERE id IN (?, ?)",
      [first.id, unknown.id],
    );
    const recovery = new WorkerRecoveryRepository(harness.db);
    expect(await recovery.abandonWithAudit(input(first.id, 2))).toEqual({
      abandoned: false,
      documentFailed: false,
    });
    expect(await recovery.abandonWithAudit(input(unknown.id))).toEqual({
      abandoned: false,
      documentFailed: false,
    });
    expect((await jobs.findById(unknown.id))?.status).toBe('running');
    expect(await recovery.abandonWithAudit(input(first.id))).toEqual({
      abandoned: true,
      documentFailed: false,
    });
    expect((await jobs.findById(first.id))?.status).toBe('dead');
    expect(
      await harness.db.query('SELECT id FROM audit_logs WHERE action = ? AND target_id = ?', [
        'worker.job_abandoned_offline',
        first.id,
      ]),
    ).toHaveLength(1);
    for (const invalid of [
      input('', 1),
      input(first.id, 0),
      { ...input(first.id), incidentReference: 'has spaces' },
      { ...input(first.id), operatorReference: '' },
    ]) {
      await expect(recovery.abandonWithAudit(invalid)).rejects.toThrow('Invalid recovery input');
      await expect(recovery.requeueWithAudit(invalid)).rejects.toThrow('Invalid recovery input');
    }
  } finally {
    await harness.close();
  }
});

it('rolls back the job and document when the abandonment audit fails', async () => {
  const harness = await createHarness();
  try {
    const account = await registerAccount(harness);
    const upload = await harness.api.upload(account.accessToken);
    const documentId = upload.json<{ id: string }>().id;
    const jobs = new JobsRepository(harness.db);
    const claimed = (await jobs.claimNext())!;
    await harness.db.execute("UPDATE documents SET status = 'processing' WHERE id = ?", [
      documentId,
    ]);
    const failing = {
      transaction: <T>(run: (db: Database) => Promise<T>) =>
        harness.db.transaction((tx) =>
          run({
            ...tx,
            execute: async (sql, params) => {
              if (sql.includes('INSERT INTO audit_logs')) throw new Error('synthetic audit error');
              return tx.execute(sql, params);
            },
          }),
        ),
    } as Database;
    await expect(
      new WorkerRecoveryRepository(failing).abandonWithAudit(input(claimed.id)),
    ).rejects.toThrow('synthetic audit error');
    expect((await jobs.findById(claimed.id))?.status).toBe('running');
    expect(await harness.db.one('SELECT status FROM documents WHERE id = ?', [documentId])).toEqual(
      { status: 'processing' },
    );
    expect(
      await harness.db.query('SELECT id FROM audit_logs WHERE action = ? AND target_id = ?', [
        'worker.job_abandoned_offline',
        claimed.id,
      ]),
    ).toHaveLength(0);
  } finally {
    await harness.close();
  }
});

it('allows only one of competing requeue and abandonment and records the winning audit', async () => {
  const harness = await createHarness();
  try {
    const account = await registerAccount(harness);
    const jobs = new JobsRepository(harness.db);
    const job = await jobs.enqueue({
      organisationId: account.organisationId,
      type: 'retention_purge',
    });
    expect((await jobs.claimNext())?.id).toBe(job.id);
    const recovery = new WorkerRecoveryRepository(harness.db);
    const [abandoned, requeued] = await Promise.all([
      recovery.abandonWithAudit(input(job.id)),
      recovery.requeueWithAudit(input(job.id)),
    ]);
    expect(Number(abandoned.abandoned) + Number(requeued)).toBe(1);
    expect((await jobs.findById(job.id))?.status).toBe(abandoned.abandoned ? 'dead' : 'queued');
    const audits = await harness.db.query<{ action: string }>(
      "SELECT action FROM audit_logs WHERE target_id = ? AND action IN ('worker.job_abandoned_offline', 'worker.job_requeued_offline')",
      [job.id],
    );
    expect(audits).toEqual([
      {
        action: abandoned.abandoned
          ? 'worker.job_abandoned_offline'
          : 'worker.job_requeued_offline',
      },
    ]);
  } finally {
    await harness.close();
  }
});

it('does not duplicate abandonment after a committed transaction loses acknowledgement', async () => {
  const harness = await createHarness();
  try {
    const account = await registerAccount(harness);
    const jobs = new JobsRepository(harness.db);
    const job = await jobs.enqueue({
      organisationId: account.organisationId,
      type: 'retention_purge',
    });
    expect((await jobs.claimNext())?.id).toBe(job.id);
    const ambiguous = {
      transaction: async <T>(run: (db: Database) => Promise<T>): Promise<T> => {
        await harness.db.transaction(run);
        throw new Error('synthetic acknowledgement loss');
      },
    } as Database;
    await expect(
      new WorkerRecoveryRepository(ambiguous).abandonWithAudit(input(job.id)),
    ).rejects.toThrow('synthetic acknowledgement loss');
    expect((await jobs.findById(job.id))?.status).toBe('dead');
    expect(await new WorkerRecoveryRepository(harness.db).abandonWithAudit(input(job.id))).toEqual({
      abandoned: false,
      documentFailed: false,
    });
    expect(
      await harness.db.query('SELECT id FROM audit_logs WHERE action = ? AND target_id = ?', [
        'worker.job_abandoned_offline',
        job.id,
      ]),
    ).toHaveLength(1);
  } finally {
    await harness.close();
  }
});

it('does not publish OCR from a current-version process that resumes after an unsafe live abandonment', async () => {
  const harness = await createHarness();
  let release!: () => void;
  let entered!: () => void;
  const paused = new Promise<void>((resolve) => {
    release = resolve;
  });
  const ready = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let running: Promise<number> | undefined;
  const original = harness.ocr.ocr.bind(harness.ocr);
  const ocr = jest.spyOn(harness.ocr, 'ocr').mockImplementationOnce(async () => {
    entered();
    await paused;
    return original();
  });
  try {
    const account = await registerAccount(harness);
    const upload = await harness.api.upload(account.accessToken);
    const id = upload.json<{ id: string }>().id;
    running = harness.services.worker.drain();
    await ready;
    const job = (await new JobsRepository(harness.db).listForDocument(id))[0]!;
    // Deliberately violate the offline requirement to demonstrate the narrow publication guard.
    expect(await new WorkerRecoveryRepository(harness.db).abandonWithAudit(input(job.id))).toEqual({
      abandoned: true,
      documentFailed: true,
    });
    release();
    await running;
    expect(
      await harness.db.query('SELECT id FROM extractions WHERE document_id = ?', [id]),
    ).toHaveLength(0);
    expect(await harness.db.one('SELECT status FROM documents WHERE id = ?', [id])).toEqual({
      status: 'failed',
    });
    expect(harness.ocr.calls).toBe(1);
  } finally {
    release();
    if (running) await running.catch(() => undefined);
    ocr.mockRestore();
    await harness.close();
  }
});

it('never changes a document belonging to a different organisation', async () => {
  const harness = await createHarness();
  try {
    const owner = await registerAccount(harness);
    const other = await registerAccount(harness, { email: 'foreign-abandon@example.com' });
    const upload = await harness.api.upload(other.accessToken);
    const documentId = upload.json<{ id: string }>().id;
    const jobs = new JobsRepository(harness.db);
    const foreign = await jobs.enqueue({
      organisationId: owner.organisationId,
      documentId,
      type: 'extract_document',
    });
    await harness.db.execute("UPDATE jobs SET status = 'running', attempts = 1 WHERE id = ?", [
      foreign.id,
    ]);
    const before = await harness.db.one('SELECT status, deleted_at FROM documents WHERE id = ?', [
      documentId,
    ]);
    expect(
      await new WorkerRecoveryRepository(harness.db).abandonWithAudit(input(foreign.id)),
    ).toEqual({ abandoned: true, documentFailed: false });
    expect(
      await harness.db.one('SELECT status, deleted_at FROM documents WHERE id = ?', [documentId]),
    ).toEqual(before);
    expect(
      await harness.db.query(
        'SELECT id FROM audit_logs WHERE action = ? AND target_id = ? AND organisation_id = ?',
        ['worker.job_abandoned_offline', foreign.id, owner.organisationId],
      ),
    ).toHaveLength(1);
  } finally {
    await harness.close();
  }
});
