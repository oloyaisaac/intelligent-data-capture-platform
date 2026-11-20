import { createHarness, registerAccount, type Harness } from './helpers';
import { AuditRepository, JobsRepository } from '../src/repositories/system-repo';

describe('retention file failure handling', () => {
  let harness: Harness;
  beforeEach(async () => {
    harness = await createHarness();
  });
  afterEach(async () => {
    await harness.close();
  });

  it('does not remove a primary file referenced by another document page', async () => {
    const account = await registerAccount(harness);
    const expiredUpload = await harness.api.upload(account.accessToken);
    const liveUpload = await harness.api.upload(account.accessToken);
    const expiredId = expiredUpload.json<{ id: string }>().id;
    const liveId = liveUpload.json<{ id: string }>().id;
    await harness.services.worker.drain();
    await harness.db.execute('UPDATE documents SET created_at = ? WHERE id = ?', [
      '2000-01-01T00:00:00.000Z',
      expiredId,
    ]);
    const document = await harness.db.one<{ storage_key: string }>(
      'SELECT storage_key FROM documents WHERE id = ?',
      [expiredId],
    );
    await harness.db.execute('UPDATE document_pages SET storage_key = ? WHERE document_id = ?', [
      document!.storage_key,
      liveId,
    ]);
    const jobs = new JobsRepository(harness.db);
    const job = await jobs.enqueue({
      organisationId: account.organisationId,
      type: 'retention_purge',
    });
    await harness.services.worker.drain();
    expect(await harness.storage.exists(document!.storage_key)).toBe(true);
    expect(
      await harness.db.one('SELECT deleted_at FROM documents WHERE id = ?', [expiredId]),
    ).toEqual({ deleted_at: null });
    expect((await jobs.findById(job.id))?.status).toBe('queued');
  });

  it('reports only completed documents when a later file fails and retries the rest', async () => {
    const account = await registerAccount(harness);
    const uploads = await Promise.all([
      harness.api.upload(account.accessToken),
      harness.api.upload(account.accessToken),
    ]);
    const ids = uploads.map((upload) => upload.json<{ id: string }>().id);
    await harness.services.worker.drain();
    for (const id of ids)
      await harness.db.execute('UPDATE documents SET created_at = ? WHERE id = ?', [
        '2000-01-01T00:00:00.000Z',
        id,
      ]);
    const jobs = new JobsRepository(harness.db);
    const job = await jobs.enqueue({
      organisationId: account.organisationId,
      type: 'retention_purge',
    });
    const original = harness.storage.delete.bind(harness.storage);
    let calls = 0;
    const fail = jest.spyOn(harness.storage, 'delete').mockImplementation(async (key) => {
      calls += 1;
      if (calls === 2) throw new Error('synthetic failure');
      await original(key);
    });
    try {
      await harness.services.worker.drain();
    } finally {
      fail.mockRestore();
    }
    const rows = await harness.db.query<{ deleted_at: string | null }>(
      'SELECT deleted_at FROM documents WHERE organisation_id = ?',
      [account.organisationId],
    );
    expect(rows.filter((row) => row.deleted_at !== null)).toHaveLength(1);
    expect(rows.filter((row) => row.deleted_at === null)).toHaveLength(1);
    expect((await jobs.findById(job.id))?.status).toBe('queued');
    const audits = await harness.db.query<{ metadata: string }>(
      'SELECT metadata FROM audit_logs WHERE organisation_id = ? AND action = ?',
      [account.organisationId, 'retention.purged'],
    );
    expect(audits).toHaveLength(1);
    expect(JSON.parse(audits[0]!.metadata)).toMatchObject({ count: 1 });
    await harness.db.execute('UPDATE jobs SET run_after = ? WHERE id = ?', [
      '2000-01-01T00:00:00.000Z',
      job.id,
    ]);
    await harness.services.worker.drain();
    expect((await jobs.findById(job.id))?.status).toBe('succeeded');
    expect(
      (
        await harness.db.query<{ deleted_at: string | null }>(
          'SELECT deleted_at FROM documents WHERE organisation_id = ?',
          [account.organisationId],
        )
      ).every((row) => row.deleted_at !== null),
    ).toBe(true);
  });

  it('writes one targeted audit per successfully purged document', async () => {
    const account = await registerAccount(harness);
    const uploads = await Promise.all([
      harness.api.upload(account.accessToken),
      harness.api.upload(account.accessToken),
    ]);
    const ids = uploads.map((upload) => upload.json<{ id: string }>().id).sort();
    await harness.services.worker.drain();
    for (const id of ids) {
      await harness.db.execute('UPDATE documents SET created_at = ? WHERE id = ?', [
        '2000-01-01T00:00:00.000Z',
        id,
      ]);
    }
    expect(await harness.services.documents.purgeExpired(account.organisationId, 1)).toBe(2);
    const audits = await harness.db.query<{ target_id: string; metadata: string }>(
      'SELECT target_id, metadata FROM audit_logs WHERE organisation_id = ? AND action = ?',
      [account.organisationId, 'retention.purged'],
    );
    expect(audits.map((entry) => entry.target_id).sort()).toEqual(ids);
    expect(audits.every((entry) => JSON.parse(entry.metadata).count === 1)).toBe(true);
  });

  it('rolls back each metadata deletion if its audit fails, then retries the missing file', async () => {
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
    const original = AuditRepository.prototype.record;
    const failure = jest
      .spyOn(AuditRepository.prototype, 'record')
      .mockImplementation(async function (this: AuditRepository, input) {
        if (input.action === 'retention.purged') throw new Error('synthetic audit failure');
        await original.call(this, input);
      });
    try {
      await harness.services.worker.drain();
    } finally {
      failure.mockRestore();
    }
    expect(await harness.storage.exists(document!.storage_key)).toBe(false);
    expect(
      await harness.db.one('SELECT deleted_at FROM documents WHERE id = ?', [documentId]),
    ).toEqual({ deleted_at: null });
    expect((await jobs.findById(job.id))?.status).toBe('queued');
    expect(
      await harness.db.query('SELECT id FROM audit_logs WHERE organisation_id = ? AND action = ?', [
        account.organisationId,
        'retention.purged',
      ]),
    ).toHaveLength(0);
    await harness.db.execute('UPDATE jobs SET run_after = ? WHERE id = ?', [
      '2000-01-01T00:00:00.000Z',
      job.id,
    ]);
    await harness.services.worker.drain();
    expect((await jobs.findById(job.id))?.status).toBe('succeeded');
    expect(
      (
        await harness.db.one<{ deleted_at: string | null }>(
          'SELECT deleted_at FROM documents WHERE id = ?',
          [documentId],
        )
      )?.deleted_at,
    ).not.toBeNull();
    const audits = await harness.db.query<{ metadata: string; target_id: string }>(
      'SELECT metadata, target_id FROM audit_logs WHERE organisation_id = ? AND action = ?',
      [account.organisationId, 'retention.purged'],
    );
    expect(audits).toHaveLength(1);
    expect(audits[0]?.target_id).toBe(documentId);
    expect(JSON.parse(audits[0]!.metadata)).toMatchObject({ count: 1 });
  });

  it('does not duplicate a committed purge audit when the commit acknowledgement is lost', async () => {
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
    const originalAudit = AuditRepository.prototype.record;
    const originalTransaction = harness.db.transaction.bind(harness.db);
    let committedPurge = false;
    const audit = jest
      .spyOn(AuditRepository.prototype, 'record')
      .mockImplementation(async function (this: AuditRepository, input) {
        await originalAudit.call(this, input);
        if (input.action === 'retention.purged') committedPurge = true;
      });
    const transaction = jest.spyOn(harness.db, 'transaction').mockImplementation(async (run) => {
      const result = await originalTransaction(run);
      if (committedPurge) {
        committedPurge = false;
        throw new Error('synthetic lost commit acknowledgement');
      }
      return result;
    });
    try {
      await harness.services.worker.drain();
    } finally {
      transaction.mockRestore();
      audit.mockRestore();
    }
    expect((await jobs.findById(job.id))?.status).toBe('queued');
    expect(
      (
        await harness.db.one<{ deleted_at: string | null }>(
          'SELECT deleted_at FROM documents WHERE id = ?',
          [documentId],
        )
      )?.deleted_at,
    ).not.toBeNull();
    await harness.db.execute('UPDATE jobs SET run_after = ? WHERE id = ?', [
      '2000-01-01T00:00:00.000Z',
      job.id,
    ]);
    await harness.services.worker.drain();
    expect((await jobs.findById(job.id))?.status).toBe('succeeded');
    expect(
      await harness.db.query(
        'SELECT id FROM audit_logs WHERE organisation_id = ? AND action = ? AND target_id = ?',
        [account.organisationId, 'retention.purged', documentId],
      ),
    ).toHaveLength(1);
  });

  it('does not mark an expired document deleted when its file deletion fails, and retries', async () => {
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
    const failure = jest
      .spyOn(harness.storage, 'delete')
      .mockRejectedValueOnce(new Error('secret storage path'));
    try {
      await harness.services.worker.drain();
    } finally {
      failure.mockRestore();
    }
    expect(await harness.storage.exists(document!.storage_key)).toBe(true);
    expect(
      await harness.db.one('SELECT deleted_at FROM documents WHERE id = ?', [documentId]),
    ).toEqual({ deleted_at: null });
    const failed = await jobs.findById(job.id);
    expect(failed?.status).toBe('queued');
    expect(failed?.last_error).not.toContain('secret storage path');
    expect(
      await harness.db.query('SELECT id FROM audit_logs WHERE action = ? AND organisation_id = ?', [
        'retention.purged',
        account.organisationId,
      ]),
    ).toHaveLength(0);
    await harness.db.execute('UPDATE jobs SET run_after = ? WHERE id = ?', [
      '2000-01-01T00:00:00.000Z',
      job.id,
    ]);
    await harness.services.worker.drain();
    expect((await jobs.findById(job.id))?.status).toBe('succeeded');
    expect(await harness.storage.exists(document!.storage_key)).toBe(false);
    expect(
      (
        await harness.db.one<{ deleted_at: string | null }>(
          'SELECT deleted_at FROM documents WHERE id = ?',
          [documentId],
        )
      )?.deleted_at,
    ).not.toBeNull();
  });
});
