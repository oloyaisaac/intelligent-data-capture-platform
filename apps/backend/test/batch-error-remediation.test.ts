import { newId } from '@idcp/shared/ids';
import type { Database } from '../src/db/database';
import { BATCH_FAILURE, SAFE_BATCH_ERRORS } from '../src/domain/batch-errors';
import { BatchErrorRemediationRepository } from '../src/repositories/batch-error-remediation-repo';
import { BatchesRepository } from '../src/repositories/batch-repo';
import { createHarness, registerAccount } from './helpers';

it('scopes remediation to one batch, preserves safe messages, audits bounded pages and is repeatable', async () => {
  const harness = await createHarness();
  try {
    const account = await registerAccount(harness);
    const foreign = await registerAccount(harness, {
      email: 'foreign-batch-remediation@example.com',
    });
    const batches = new BatchesRepository(harness.db);
    const batch = await batches.create({
      organisationId: account.organisationId,
      name: 'test',
      createdBy: account.userId,
    });
    const other = await batches.create({
      organisationId: foreign.organisationId,
      name: 'foreign',
      createdBy: foreign.userId,
    });
    for (let position = 0; position < 102; position++)
      await batches.addItem({
        batchId: batch.id,
        documentId: null,
        position,
        error: `SYNTHETIC-SECRET-${position}`,
      });
    for (const [index, error] of [...SAFE_BATCH_ERRORS, '', null].entries())
      await batches.addItem({ batchId: batch.id, documentId: null, position: 102 + index, error });
    await batches.addItem({
      batchId: other.id,
      documentId: null,
      position: 0,
      error: 'FOREIGN-SECRET',
    });
    const repo = new BatchErrorRemediationRepository(harness.db);
    const scope = { organisationId: account.organisationId, batchId: batch.id };
    const input = { ...scope, operatorReference: 'operator-1', incidentReference: 'INC-42' };
    expect(await repo.check(scope)).toEqual({ found: true, eligible: 102 });
    expect(await repo.check({ ...scope, organisationId: foreign.organisationId })).toEqual({
      found: false,
      eligible: 0,
    });
    expect(await repo.apply({ ...input, organisationId: foreign.organisationId })).toEqual({
      found: false,
      changed: 0,
      remaining: false,
    });
    const results = await Promise.all([repo.apply(input), repo.apply(input)]);
    expect(results.map((r) => r.changed).sort((a, b) => b - a)).toEqual([100, 2]);
    expect(await repo.check(scope)).toEqual({ found: true, eligible: 0 });
    expect(await repo.apply(input)).toEqual({ found: true, changed: 0, remaining: false });
    const rows = await harness.db.query<{ error: string | null }>(
      'SELECT error FROM batch_items WHERE batch_id = ? ORDER BY position',
      [batch.id],
    );
    expect(rows.slice(0, 102).every((row) => row.error === BATCH_FAILURE)).toBe(true);
    expect(rows.slice(102).map((row) => row.error)).toEqual([...SAFE_BATCH_ERRORS, '', null]);
    expect(
      await harness.db.one('SELECT error FROM batch_items WHERE batch_id = ?', [other.id]),
    ).toEqual({ error: 'FOREIGN-SECRET' });
    const audits = await harness.db.query<{
      organisation_id: string;
      actor_type: string;
      actor_id: string | null;
      metadata: string;
    }>(
      'SELECT organisation_id, actor_type, actor_id, metadata FROM audit_logs WHERE action = ? AND target_id = ?',
      ['batch.errors_remediated_offline', batch.id],
    );
    expect(audits).toHaveLength(2);
    expect(
      audits.map((row) => JSON.parse(row.metadata).count).sort((a: number, b: number) => b - a),
    ).toEqual([100, 2]);
    for (const audit of audits) {
      expect(audit).toMatchObject({
        organisation_id: account.organisationId,
        actor_type: 'system',
        actor_id: null,
      });
      expect(JSON.parse(audit.metadata)).toMatchObject({
        operatorReference: 'operator-1',
        incidentReference: 'INC-42',
      });
      expect(audit.metadata).not.toContain('SYNTHETIC-SECRET');
    }
  } finally {
    await harness.close();
  }
}, 30_000);

it('rolls back all changes if the audit insert fails', async () => {
  const harness = await createHarness();
  try {
    const account = await registerAccount(harness);
    const batches = new BatchesRepository(harness.db);
    const batch = await batches.create({
      organisationId: account.organisationId,
      name: 'test',
      createdBy: account.userId,
    });
    await batches.addItem({
      batchId: batch.id,
      documentId: null,
      position: 0,
      error: 'SYNTHETIC-SECRET',
    });
    const wrapper: Database = {
      driver: harness.db.driver,
      query: harness.db.query.bind(harness.db),
      one: harness.db.one.bind(harness.db),
      execute: harness.db.execute.bind(harness.db),
      close: async () => undefined,
      transaction: (fn) =>
        harness.db.transaction((tx) =>
          fn({
            driver: tx.driver,
            query: tx.query.bind(tx),
            one: tx.one.bind(tx),
            close: async () => undefined,
            transaction: tx.transaction.bind(tx),
            execute: async (sql, params) => {
              if (sql.includes('INSERT INTO audit_logs'))
                throw new Error('synthetic audit failure');
              return tx.execute(sql, params);
            },
          }),
        ),
    };
    const repo = new BatchErrorRemediationRepository(wrapper);
    await expect(
      repo.apply({
        organisationId: account.organisationId,
        batchId: batch.id,
        operatorReference: 'op',
        incidentReference: 'INC-42',
      }),
    ).rejects.toThrow('synthetic audit failure');
    expect(
      await harness.db.one('SELECT error FROM batch_items WHERE batch_id = ?', [batch.id]),
    ).toEqual({ error: 'SYNTHETIC-SECRET' });
    expect(
      await harness.db.query('SELECT id FROM audit_logs WHERE action = ? AND target_id = ?', [
        'batch.errors_remediated_offline',
        batch.id,
      ]),
    ).toHaveLength(0);
  } finally {
    await harness.close();
  }
});

it('rejects invalid scope and audit references before making changes', async () => {
  const harness = await createHarness();
  try {
    const repo = new BatchErrorRemediationRepository(harness.db);
    await expect(repo.check({ organisationId: '', batchId: newId() })).rejects.toThrow();
    await expect(
      repo.apply({
        organisationId: newId(),
        batchId: newId(),
        operatorReference: 'bad operator',
        incidentReference: 'incident',
      }),
    ).rejects.toThrow();
  } finally {
    await harness.close();
  }
});

it('lists only the selected organisation in bounded pages without returning stored text', async () => {
  const harness = await createHarness();
  try {
    const account = await registerAccount(harness);
    const foreign = await registerAccount(harness, { email: 'foreign-batch-list@example.com' });
    const batches = new BatchesRepository(harness.db);
    for (let index = 0; index < 102; index++) {
      const batch = await batches.create({
        organisationId: account.organisationId,
        name: 'private batch',
        createdBy: account.userId,
      });
      await batches.addItem({
        batchId: batch.id,
        documentId: null,
        position: 0,
        error: 'LIST-SYNTHETIC-SECRET',
      });
    }
    const safe = await batches.create({
      organisationId: account.organisationId,
      name: 'safe',
      createdBy: account.userId,
    });
    await batches.addItem({
      batchId: safe.id,
      documentId: null,
      position: 0,
      error: BATCH_FAILURE,
    });
    const other = await batches.create({
      organisationId: foreign.organisationId,
      name: 'foreign',
      createdBy: foreign.userId,
    });
    await batches.addItem({
      batchId: other.id,
      documentId: null,
      position: 0,
      error: 'FOREIGN-LIST-SECRET',
    });
    const repo = new BatchErrorRemediationRepository(harness.db);
    const first = await repo.list(account.organisationId, null);
    expect(first.batches).toHaveLength(100);
    expect(first.nextAfter).toBe(first.batches[99]!.batchId);
    const second = await repo.list(account.organisationId, first.nextAfter);
    expect(second.batches).toHaveLength(2);
    expect(second.nextAfter).toBeNull();
    expect(new Set([...first.batches, ...second.batches].map((row) => row.batchId)).size).toBe(102);
    expect([...first.batches, ...second.batches].every((row) => row.eligible === 1)).toBe(true);
    expect(JSON.stringify([first, second])).not.toContain('SECRET');
    expect(JSON.stringify([first, second])).not.toContain(other.id);
    expect(JSON.stringify([first, second])).not.toContain(safe.id);
    expect((await repo.list(foreign.organisationId, null)).batches).toEqual([
      { batchId: other.id, eligible: 1 },
    ]);
    await expect(repo.list(account.organisationId, 'bad cursor with spaces')).rejects.toThrow();
  } finally {
    await harness.close();
  }
}, 30_000);
