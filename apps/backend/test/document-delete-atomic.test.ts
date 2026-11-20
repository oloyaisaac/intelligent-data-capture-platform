import { AuditRepository } from '../src/repositories/system-repo';
import { createHarness, registerAccount } from './helpers';

it('commits a document soft-delete and its audit together, or neither', async () => {
  const harness = await createHarness();
  try {
    const account = await registerAccount(harness);
    const upload = await harness.api.upload(account.accessToken);
    const id = upload.json<{ id: string }>().id;
    const original = AuditRepository.prototype.record;
    const audit = jest
      .spyOn(AuditRepository.prototype, 'record')
      .mockImplementation(async function (this: AuditRepository, input) {
        if (input.action === 'document.deleted') throw new Error('synthetic audit failure');
        await original.call(this, input);
      });
    try {
      const result = await harness.api.json('DELETE', `/api/v1/documents/${id}`, {
        token: account.accessToken,
      });
      expect(result.statusCode).toBe(500);
      expect(
        await harness.db.one('SELECT status, deleted_at FROM documents WHERE id = ?', [id]),
      ).toEqual({ status: 'queued', deleted_at: null });
      expect(
        await harness.db.query('SELECT id FROM audit_logs WHERE action = ? AND target_id = ?', [
          'document.deleted',
          id,
        ]),
      ).toHaveLength(0);
    } finally {
      audit.mockRestore();
    }
    const retried = await harness.api.json('DELETE', `/api/v1/documents/${id}`, {
      token: account.accessToken,
    });
    expect(retried.statusCode).toBe(204);
    expect(
      await harness.db.query('SELECT id FROM audit_logs WHERE action = ? AND target_id = ?', [
        'document.deleted',
        id,
      ]),
    ).toHaveLength(1);
  } finally {
    await harness.close();
  }
});

it('only one of two concurrent delete requests succeeds and records a deletion', async () => {
  const harness = await createHarness();
  try {
    const account = await registerAccount(harness);
    const upload = await harness.api.upload(account.accessToken);
    const id = upload.json<{ id: string }>().id;
    const remove = () =>
      harness.api.json('DELETE', `/api/v1/documents/${id}`, { token: account.accessToken });
    const responses = await Promise.all([remove(), remove()]);
    expect(responses.map((response) => response.statusCode).sort()).toEqual([204, 404]);
    expect(
      await harness.db.query('SELECT id FROM audit_logs WHERE action = ? AND target_id = ?', [
        'document.deleted',
        id,
      ]),
    ).toHaveLength(1);
  } finally {
    await harness.close();
  }
});
