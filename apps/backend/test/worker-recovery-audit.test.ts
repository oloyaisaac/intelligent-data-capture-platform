import type { Database } from '../src/db/database';
import { JobsRepository } from '../src/repositories/system-repo';
import { WorkerRecoveryRepository } from '../src/repositories/worker-recovery-repo';
import { createHarness, registerAccount } from './helpers';

it('rolls back recovery if its audit write fails, and audits exactly one competing recovery', async () => {
  const harness = await createHarness();
  try {
    const account = await registerAccount(harness);
    const jobs = new JobsRepository(harness.db);
    const job = await jobs.enqueue({
      organisationId: account.organisationId,
      type: 'retention_purge',
    });
    expect((await jobs.claimNext())?.id).toBe(job.id);
    const input = {
      id: job.id,
      attempt: 1,
      operatorReference: 'operator-1',
      incidentReference: 'INC-42',
    };
    const failing = {
      transaction: <T>(run: (db: Database) => Promise<T>) =>
        harness.db.transaction((tx) =>
          run({
            ...tx,
            execute: async (sql, params) => {
              if (sql.includes('INSERT INTO audit_logs'))
                throw new Error('synthetic audit failure');
              return tx.execute(sql, params);
            },
          }),
        ),
    } as Database;
    await expect(new WorkerRecoveryRepository(failing).requeueWithAudit(input)).rejects.toThrow(
      'synthetic audit failure',
    );
    expect((await jobs.findById(job.id))?.status).toBe('running');
    expect(
      await harness.db.query('SELECT id FROM audit_logs WHERE action = ? AND target_id = ?', [
        'worker.job_requeued_offline',
        job.id,
      ]),
    ).toHaveLength(0);
    const repository = new WorkerRecoveryRepository(harness.db);
    const results = await Promise.all([
      repository.requeueWithAudit(input),
      repository.requeueWithAudit(input),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);
    expect((await jobs.findById(job.id))?.status).toBe('queued');
    const audits = await harness.db.query(
      'SELECT id FROM audit_logs WHERE action = ? AND target_id = ?',
      ['worker.job_requeued_offline', job.id],
    );
    expect(audits).toHaveLength(1);
  } finally {
    await harness.close();
  }
});
