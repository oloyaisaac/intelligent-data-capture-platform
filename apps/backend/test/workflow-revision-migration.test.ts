import type { Database } from '../src/db/database';
import { applyMigrations } from '../src/db/migrations';
import { WorkflowRunsRepository, WorkflowsRepository } from '../src/repositories/workflow-repo';
import { createHarness } from './helpers';

it('rolls back revision DDL on marker failure and preserves legacy plans without backfilling them', async () => {
  const harness = await createHarness();
  try {
    const workflow = await new WorkflowsRepository(harness.db).create({
      organisationId: 'synthetic-org',
      name: 'Existing',
      trigger: 'document.approved',
      documentType: null,
      conditions: [],
      actions: [{ type: 'delete_document' }],
      approvalPolicy: 'always_ask',
      createdBy: 'synthetic-user',
    });
    const run = await new WorkflowRunsRepository(harness.db).create({
      organisationId: 'synthetic-org',
      workflowId: workflow.id,
      documentId: null,
      trigger: 'document.approved',
      status: 'awaiting_approval',
      matched: true,
      explanation: 'legacy',
      actions: [{ type: 'delete_document' }],
    });
    const legacy = JSON.stringify({
      reviewId: 'review',
      extractionId: 'extraction',
      conditionSemanticsVersion: 1,
    });
    await harness.db.execute('UPDATE workflow_runs SET approval_snapshot = ? WHERE id = ?', [
      legacy,
      run.id,
    ]);
    await harness.db.execute('ALTER TABLE workflows DROP COLUMN revision');
    await harness.db.execute('DELETE FROM schema_migrations WHERE id = ?', [
      '016_workflow_revision',
    ]);
    const intercept = (target: Database): Database => ({
      driver: target.driver,
      query: target.query.bind(target),
      one: target.one.bind(target),
      close: target.close.bind(target),
      transaction: (fn) => target.transaction((tx) => fn(intercept(tx))),
      execute: async (sql, params) => {
        if (
          sql.startsWith('INSERT INTO schema_migrations') &&
          params?.[0] === '016_workflow_revision'
        )
          throw new Error('synthetic marker failure');
        return target.execute(sql, params);
      },
    });
    await expect(applyMigrations(intercept(harness.db))).rejects.toThrow(
      'synthetic marker failure',
    );
    const columns =
      harness.db.driver === 'postgres'
        ? await harness.db.query<{ name: string }>(
            "SELECT column_name AS name FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'workflows'",
          )
        : await harness.db.query<{ name: string }>('PRAGMA table_info(workflows)');
    expect(columns.map((column) => column.name)).not.toContain('revision');
    expect(
      await harness.db.one('SELECT id FROM schema_migrations WHERE id = ?', [
        '016_workflow_revision',
      ]),
    ).toBeNull();
    expect(await applyMigrations(harness.db)).toEqual(['016_workflow_revision']);
    expect(await applyMigrations(harness.db)).toEqual([]);
    const migrated = await harness.db.one<{ revision: number | string }>(
      'SELECT revision FROM workflows WHERE id = ?',
      [workflow.id],
    );
    expect(Number(migrated?.revision)).toBe(0);
    expect(
      await harness.db.one('SELECT approval_snapshot FROM workflow_runs WHERE id = ?', [run.id]),
    ).toEqual({ approval_snapshot: legacy });
    const inserted = await new WorkflowsRepository(harness.db).create({
      organisationId: 'synthetic-org',
      name: 'Old-writer default',
      trigger: 'document.approved',
      documentType: null,
      conditions: [],
      actions: [{ type: 'delete_document' }],
      approvalPolicy: 'always_ask',
      createdBy: 'synthetic-user',
    });
    const defaulted = await harness.db.one<{ revision: number | string }>(
      'SELECT revision FROM workflows WHERE id = ?',
      [inserted.id],
    );
    expect(Number(defaulted?.revision)).toBe(0);
  } finally {
    await harness.close();
  }
});
