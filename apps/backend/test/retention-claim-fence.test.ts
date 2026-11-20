import { JobsRepository } from '../src/repositories/system-repo';
import { WorkerRecoveryRepository } from '../src/repositories/worker-recovery-repo';
import { createHarness, registerAccount } from './helpers';

it('does not delete an expired document when the purge claim was abandoned before its destructive transaction', async () => {
  const harness = await createHarness();
  try {
    const account = await registerAccount(harness);
    const upload = await harness.api.upload(account.accessToken);
    const documentId = upload.json<{ id: string }>().id;
    await harness.services.worker.drain();
    await harness.db.execute('UPDATE documents SET created_at = ? WHERE id = ?', [
      '2000-01-01T00:00:00.000Z',
      documentId,
    ]);
    const document = await harness.db.one<{ storage_key: string }>(
      'SELECT storage_key FROM documents WHERE id = ?',
      [documentId],
    );
    const jobs = new JobsRepository(harness.db);
    const job = await jobs.enqueue({
      organisationId: account.organisationId,
      type: 'retention_purge',
    });
    expect((await jobs.claimNext())?.id).toBe(job.id);
    expect(
      await new WorkerRecoveryRepository(harness.db).abandonWithAudit({
        id: job.id,
        attempt: 1,
        operatorReference: 'operator-test',
        incidentReference: 'INC-42',
      }),
    ).toEqual({ abandoned: true, documentFailed: false });
    await expect(
      harness.services.documents.purgeExpired(account.organisationId, 90, {
        id: job.id,
        attempt: 1,
      }),
    ).rejects.toThrow('Retention purge incomplete');
    expect(await harness.storage.exists(document!.storage_key)).toBe(true);
    expect(
      await harness.db.one('SELECT deleted_at FROM documents WHERE id = ?', [documentId]),
    ).toEqual({ deleted_at: null });
    expect(
      await harness.db.query('SELECT id FROM audit_logs WHERE action = ?', ['retention.purged']),
    ).toHaveLength(0);
  } finally {
    await harness.close();
  }
});

it('requires the exact running retention claim and tenant before deleting', async () => {
  const harness = await createHarness();
  try {
    const account = await registerAccount(harness);
    const upload = await harness.api.upload(account.accessToken);
    const documentId = upload.json<{ id: string }>().id;
    await harness.services.worker.drain();
    await harness.db.execute('UPDATE documents SET created_at = ? WHERE id = ?', [
      '2000-01-01T00:00:00.000Z',
      documentId,
    ]);
    const document = await harness.db.one<{ storage_key: string }>(
      'SELECT storage_key FROM documents WHERE id = ?',
      [documentId],
    );
    const jobs = new JobsRepository(harness.db);
    const job = await jobs.enqueue({
      organisationId: account.organisationId,
      type: 'retention_purge',
    });
    const wrongType = await jobs.enqueue({
      organisationId: account.organisationId,
      type: 'unknown_job',
    });
    const other = await registerAccount(harness, { email: 'retention-claim-other@example.com' });
    const wrongTenant = await jobs.enqueue({
      organisationId: other.organisationId,
      type: 'retention_purge',
    });
    await harness.db.execute(
      "UPDATE jobs SET status = 'running', attempts = 1 WHERE id IN (?, ?, ?)",
      [job.id, wrongType.id, wrongTenant.id],
    );
    for (const claim of [
      { id: 'missing', attempt: 1 },
      { id: job.id, attempt: 2 },
      { id: wrongType.id, attempt: 1 },
      { id: wrongTenant.id, attempt: 1 },
    ]) {
      await expect(
        harness.services.documents.purgeExpired(account.organisationId, 90, claim),
      ).rejects.toThrow('Retention purge incomplete');
      expect(await harness.storage.exists(document!.storage_key)).toBe(true);
      expect(
        await harness.db.one('SELECT deleted_at FROM documents WHERE id = ?', [documentId]),
      ).toEqual({ deleted_at: null });
    }
    expect(
      await harness.services.documents.purgeExpired(account.organisationId, 90, {
        id: job.id,
        attempt: 1,
      }),
    ).toBe(1);
  } finally {
    await harness.close();
  }
});

it('serializes abandonment behind a destructive retention transaction', async () => {
  const harness = await createHarness();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let enter!: () => void;
  const entered = new Promise<void>((resolve) => {
    enter = resolve;
  });
  let purge: Promise<number> | undefined;
  let abandonment: ReturnType<WorkerRecoveryRepository['abandonWithAudit']> | undefined;
  try {
    const account = await registerAccount(harness);
    const upload = await harness.api.upload(account.accessToken);
    const documentId = upload.json<{ id: string }>().id;
    await harness.services.worker.drain();
    await harness.db.execute('UPDATE documents SET created_at = ? WHERE id = ?', [
      '2000-01-01T00:00:00.000Z',
      documentId,
    ]);
    const jobs = new JobsRepository(harness.db);
    const job = await jobs.enqueue({
      organisationId: account.organisationId,
      type: 'retention_purge',
    });
    expect((await jobs.claimNext())?.id).toBe(job.id);
    const original = harness.storage.delete.bind(harness.storage);
    const spy = jest.spyOn(harness.storage, 'delete').mockImplementation(async (key) => {
      enter();
      await gate;
      await original(key);
    });
    purge = harness.services.documents.purgeExpired(account.organisationId, 90, {
      id: job.id,
      attempt: 1,
    });
    await entered;
    abandonment = new WorkerRecoveryRepository(harness.db).abandonWithAudit({
      id: job.id,
      attempt: 1,
      operatorReference: 'operator-test',
      incidentReference: 'INC-42',
    });
    let resolved = false;
    void abandonment.then(() => {
      resolved = true;
    });
    await new Promise((resolve) => setImmediate(resolve));
    expect(resolved).toBe(false);
    release();
    expect(await purge).toBe(1);
    expect(await abandonment).toEqual({ abandoned: true, documentFailed: false });
    expect((await jobs.findById(job.id))?.status).toBe('dead');
    expect(
      (
        await harness.db.one<{ deleted_at: string | null }>(
          'SELECT deleted_at FROM documents WHERE id = ?',
          [documentId],
        )
      )?.deleted_at,
    ).not.toBeNull();
    spy.mockRestore();
  } finally {
    release();
    await purge?.catch(() => undefined);
    await abandonment?.catch(() => undefined);
    await harness.close();
  }
}, 30_000);
