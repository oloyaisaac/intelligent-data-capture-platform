import {
  approveDocument,
  createHarness,
  drainWorker,
  fakePng,
  registerAccount,
  SAMPLE_INVOICE_TEXT,
  uploadDocument,
  type Harness,
  type TestAccount,
} from './helpers';
import {
  DESTRUCTIVE_ACTIONS,
  evaluateCondition,
  planWorkflow,
  validateWorkflow,
  type WorkflowCondition,
  type WorkflowDefinition,
} from '../src/workflows/engine';

/**
 * AGENT-001 — workflow automation.
 *
 * The engine is tested directly (it is pure), and the API is tested for the two things a person
 * depends on: nothing destructive runs unattended, and every evaluation is logged.
 */
describe('workflow automation (AGENT-001)', () => {
  const base: WorkflowDefinition = {
    id: 'wf-1',
    name: 'File large invoices',
    trigger: 'document.approved',
    documentType: 'invoice',
    conditions: [{ field: 'total.amount', operator: 'greater_than', value: 100 }],
    actions: [
      { type: 'notify', config: { message: 'Large invoice approved' } },
      { type: 'send_to_connector', config: { connectorId: 'conn-1' } },
    ],
    approvalPolicy: 'always_ask',
    enabled: true,
  };

  const context = {
    trigger: 'document.approved' as const,
    documentType: 'invoice',
    fields: { 'total.amount': 240, 'invoice.number': 'INV-9', vendor: 'Acme Ltd' },
  };

  describe('engine', () => {
    it('matches on trigger, type and conditions, and names the failed condition when it does not', () => {
      const matched = planWorkflow(base, context);
      expect(matched.matched).toBe(true);
      expect(matched.actions.map((action) => action.type)).toEqual(['notify', 'send_to_connector']);

      const wrongTrigger = planWorkflow(base, { ...context, trigger: 'document.extracted' });
      expect(wrongTrigger.matched).toBe(false);
      expect(wrongTrigger.explanation).toMatch(/Triggered by document.extracted/);

      const smallInvoice = planWorkflow(base, {
        ...context,
        fields: { 'total.amount': 12 },
      });
      expect(smallInvoice.matched).toBe(false);
      expect(smallInvoice.explanation).toMatch(/total.amount greater than 100/);
    });

    it('marks destructive actions as needing approval, and says why', () => {
      const plan = planWorkflow(base, context);
      const send = plan.actions.find((action) => action.type === 'send_to_connector')!;
      const notify = plan.actions.find((action) => action.type === 'notify')!;
      expect(send.requiresApproval).toBe(true);
      expect(send.reason).toMatch(/external system/i);
      expect(notify.requiresApproval).toBe(false);
      expect(plan.needsApproval).toBe(true);
    });

    it('only lets an auto-approve workflow run unattended', () => {
      const auto = planWorkflow({ ...base, approvalPolicy: 'auto_approve' }, context);
      expect(auto.actions.every((action) => !action.requiresApproval)).toBe(true);
      expect(auto.needsApproval).toBe(false);
      // The action list is still flagged destructive; approval policy decides whether it waits.
      expect(auto.actions.some((action) => action.destructive)).toBe(true);
    });

    it('evaluates every operator, and fails closed on the ones that cannot apply', () => {
      const check = (
        operator: Parameters<typeof evaluateCondition>[0]['operator'],
        value: unknown,
        field = 'total.amount',
      ) => evaluateCondition({ field, operator, value: value as never }, context);

      expect(check('exists', undefined)).toBe(true);
      expect(evaluateCondition({ field: 'missing.path', operator: 'exists' }, context)).toBe(false);
      expect(check('equals', '240')).toBe(true);
      expect(check('not_equals', 240)).toBe(false);
      expect(check('contains', 'acme', 'vendor')).toBe(true);
      expect(check('starts_with', 'ACME', 'vendor')).toBe(true);
      expect(check('greater_than', 100)).toBe(true);
      expect(check('less_than', 100)).toBe(false);
      expect(check('in', ['100', '240'])).toBe(true);
      expect(check('in', 'x,240')).toBe(true);
      // A text field cannot be "greater than" anything: no silent coercion.
      expect(
        evaluateCondition({ field: 'vendor', operator: 'greater_than', value: 1 }, context),
      ).toBe(false);
    });

    it('ignores inherited field names but evaluates actual own fields', () => {
      for (const field of Object.getOwnPropertyNames(Object.prototype)) {
        expect(evaluateCondition({ field, operator: 'exists' }, context)).toBe(false);
      }
      const inherited = Object.create({ secret: 'value' }) as Record<string, unknown>;
      expect(
        evaluateCondition(
          { field: 'secret', operator: 'exists' },
          { ...context, fields: inherited },
        ),
      ).toBe(false);
      expect(
        evaluateCondition(
          { field: 'secret', operator: 'equals', value: 'value' },
          { ...context, fields: inherited },
        ),
      ).toBe(false);
      expect(
        evaluateCondition(
          { field: 'secret', operator: 'not_equals', value: 'value' },
          { ...context, fields: inherited },
        ),
      ).toBe(false);
      const fields = Object.fromEntries([
        ['toString', 'real'],
        ['__proto__', 'own value'],
        ['count', 0],
        ['paid', false],
      ]);
      expect(
        evaluateCondition(
          { field: 'toString', operator: 'equals', value: 'real' },
          { ...context, fields },
        ),
      ).toBe(true);
      expect(
        evaluateCondition(
          { field: '__proto__', operator: 'equals', value: 'own value' },
          { ...context, fields },
        ),
      ).toBe(true);
      expect(
        evaluateCondition({ field: 'count', operator: 'exists' }, { ...context, fields }),
      ).toBe(true);
      expect(evaluateCondition({ field: 'paid', operator: 'exists' }, { ...context, fields })).toBe(
        true,
      );
      expect(
        evaluateCondition(
          { field: 'documentType', operator: 'equals', value: 'invoice' },
          { ...context, fields },
        ),
      ).toBe(true);
    });

    it('does not match any operator against absent, undefined, null or empty fields', () => {
      const conditions: WorkflowCondition[] = [
        { field: 'field', operator: 'exists' },
        { field: 'field', operator: 'equals', value: 'null' },
        { field: 'field', operator: 'equals', value: '' },
        { field: 'field', operator: 'not_equals', value: 'anything' },
        { field: 'field', operator: 'contains', value: '' },
        { field: 'field', operator: 'starts_with', value: '' },
        { field: 'field', operator: 'greater_than', value: 0 },
        { field: 'field', operator: 'less_than', value: 0 },
        { field: 'field', operator: 'in', value: ['null', ''] },
      ];
      for (const fields of [{}, { field: undefined }, { field: null }, { field: '' }]) {
        for (const condition of conditions) {
          expect(evaluateCondition(condition, { ...context, fields })).toBe(false);
        }
      }
      for (const documentType of [undefined, null, '']) {
        expect(
          evaluateCondition(
            { field: 'documentType', operator: 'not_equals', value: 'invoice' },
            { ...context, documentType },
          ),
        ).toBe(false);
        expect(
          evaluateCondition(
            { field: 'documentType', operator: 'equals', value: 'null' },
            { ...context, documentType },
          ),
        ).toBe(false);
      }
      expect(
        evaluateCondition(
          { field: 'zero', operator: 'not_equals', value: 1 },
          { ...context, fields: { zero: 0 } },
        ),
      ).toBe(true);
      expect(
        evaluateCondition(
          { field: 'paid', operator: 'equals', value: false },
          { ...context, fields: { paid: false } },
        ),
      ).toBe(true);
    });

    it('does not match comparisons when the operand is absent or null', () => {
      for (const operator of [
        'equals',
        'not_equals',
        'contains',
        'starts_with',
        'greater_than',
        'less_than',
        'in',
      ] as const) {
        for (const value of [undefined, null]) {
          expect(
            evaluateCondition({ field: 'vendor', operator, value: value as never }, context),
          ).toBe(false);
        }
      }
      expect(evaluateCondition({ field: 'vendor', operator: 'exists' }, context)).toBe(true);
    });

    it('rejects a definition that could never work', () => {
      expect(
        validateWorkflow({
          name: '  ',
          trigger: 'document.exploded',
          conditions: [{ field: '', operator: 'equals' }],
          actions: [],
        }),
      ).toEqual(
        expect.arrayContaining([
          'Give the workflow a name.',
          expect.stringContaining('Trigger must be one of'),
          'A workflow needs at least one action.',
          'Every condition needs a field.',
        ]),
      );
      expect(validateWorkflow(base)).toEqual([]);
      expect(DESTRUCTIVE_ACTIONS).toEqual(
        expect.arrayContaining(['send_to_connector', 'delete_document']),
      );
    });
  });

  describe('API', () => {
    let harness: Harness;

    beforeAll(async () => {
      harness = await createHarness();
    });

    afterAll(async () => {
      await harness.close();
    });

    async function approvedInvoice(account: TestAccount) {
      harness.ocr.setText(SAMPLE_INVOICE_TEXT);
      const upload = await uploadDocument(harness, account, {
        content: fakePng(`workflow-${Math.random()}`),
      });
      const documentId = upload.json<{ id: string }>().id;
      await drainWorker(harness);
      await approveDocument(harness, account, documentId);
      return documentId;
    }

    async function createWorkflow(account: TestAccount, overrides: Record<string, unknown> = {}) {
      const response = await harness.api.json('POST', '/api/v1/workflows', {
        token: account.accessToken,
        body: {
          name: 'Notify on approval',
          trigger: 'document.approved',
          conditions: [],
          actions: [{ type: 'notify', config: { message: 'Approved' } }],
          ...overrides,
        },
      });
      return response;
    }

    it('creates a workflow and evaluates it against a real document, logging the outcome', async () => {
      const account = await registerAccount(harness);
      const created = await createWorkflow(account, {
        name: 'Notify invoices',
        documentType: 'invoice',
        actions: [{ type: 'notify', config: { message: 'Invoice approved' } }],
      });
      expect(created.statusCode).toBe(201);

      const documentId = await approvedInvoice(account);
      const evaluation = await harness.api.json('POST', '/api/v1/workflows/evaluate', {
        token: account.accessToken,
        body: { trigger: 'document.approved', documentId },
      });
      expect(evaluation.statusCode).toBe(200);
      const body = evaluation.json<{
        plans: Array<{ matched: boolean }>;
        runs: Array<{ status: string; matched: boolean }>;
      }>();
      expect(body.plans.some((plan) => plan.matched)).toBe(true);
      expect(body.runs.every((run) => run.matched)).toBe(true);

      // Notify has no delivery implementation and must not claim success.
      const runs = await harness.api.json('GET', '/api/v1/workflows/runs', {
        token: account.accessToken,
      });
      const run = runs.json<{
        items: Array<{ status: string; outputs: string[]; failure: string }>;
      }>().items[0]!;
      expect(run.status).toBe('failed');
      expect(run.outputs).toEqual([]);
      expect(run.failure).toMatch(/unavailable action/);
    });

    it('holds a destructive action until a person approves that run', async () => {
      const account = await registerAccount(harness);
      await createWorkflow(account, {
        name: 'Send to CRM',
        actions: [{ type: 'send_to_connector', config: { connectorId: 'conn-9' } }],
      });

      const documentId = await approvedInvoice(account);
      const evaluation = await harness.api.json('POST', '/api/v1/workflows/evaluate', {
        token: account.accessToken,
        body: { trigger: 'document.approved', documentId },
      });
      const run = evaluation.json<{
        runs: Array<{ id: string; status: string; actions: Array<{ requiresApproval: boolean }> }>;
      }>().runs[0]!;
      expect(run.status).toBe('awaiting_approval');
      expect(run.actions[0]!.requiresApproval).toBe(true);

      const approved = await harness.api.json('POST', `/api/v1/workflows/runs/${run.id}/approve`, {
        token: account.accessToken,
      });
      expect(approved.statusCode).toBe(409);
      const row = await harness.db.one<{
        status: string;
        outputs: string;
        approved_by: string | null;
        failure: string;
      }>('SELECT status, outputs, approved_by, failure FROM workflow_runs WHERE id = ?', [run.id]);
      expect(row?.status).toBe('failed');
      expect(JSON.parse(row!.outputs)).toEqual([]);
      expect(row?.approved_by).toBeNull();
      expect(row?.failure).toMatch(/unavailable action/);

      // Approving twice is a conflict, not a second write.
      const twice = await harness.api.json('POST', `/api/v1/workflows/runs/${run.id}/approve`, {
        token: account.accessToken,
      });
      expect(twice.statusCode).toBe(409);
    });

    it.each(['notify', 'send_to_connector', 'create_export'])(
      'fails closed on %s before executing any action in a mixed plan',
      async (type) => {
        for (const policy of ['always_ask', 'auto_approve']) {
          const account = await registerAccount(harness);
          const created = await createWorkflow(account, {
            name: 'Do not partially execute',
            approvalPolicy: policy,
            actions: [
              { type: 'delete_document', config: {} },
              { type, config: { message: 'sensitive-config-value' } },
            ],
          });
          expect(created.statusCode).toBe(201);
          const documentId = await approvedInvoice(account);
          const evaluation = await harness.api.json('POST', '/api/v1/workflows/evaluate', {
            token: account.accessToken,
            body: { trigger: 'document.approved', documentId },
          });
          const run = evaluation.json<{
            runs: Array<{ id: string; status: string; failure: string | null }>;
          }>().runs[0]!;
          if (policy === 'always_ask') {
            expect(run.status).toBe('awaiting_approval');
            const response = await harness.api.json(
              'POST',
              `/api/v1/workflows/runs/${run.id}/approve`,
              {
                token: account.accessToken,
              },
            );
            expect(response.statusCode).toBe(409);
            expect(response.body).not.toContain('sensitive-config-value');
          } else {
            expect(run.status).toBe('failed');
            expect(run.failure).toMatch(/unavailable action/);
          }
          expect(
            await harness.db.one('SELECT deleted_at FROM documents WHERE id = ?', [documentId]),
          ).toEqual({ deleted_at: null });
          const row = await harness.db.one<{ status: string; outputs: string; failure: string }>(
            'SELECT status, outputs, failure FROM workflow_runs WHERE id = ?',
            [run.id],
          );
          expect(row?.status).toBe('failed');
          expect(JSON.parse(row!.outputs)).toEqual([]);
          expect(row?.failure).not.toContain('sensitive-config-value');
        }
      },
      30_000,
    );

    it.each(['auto_approve', 'always_ask'])(
      'does not match an inherited field or delete a document with %s policy',
      async (policy) => {
        const account = await registerAccount(harness);
        const created = await createWorkflow(account, {
          name: 'Missing field must not match',
          conditions: [{ field: 'toString', operator: 'exists' }],
          approvalPolicy: policy,
          actions: [{ type: 'delete_document', config: {} }],
        });
        expect(created.statusCode).toBe(201);
        const documentId = await approvedInvoice(account);
        const evaluation = await harness.api.json('POST', '/api/v1/workflows/evaluate', {
          token: account.accessToken,
          body: { trigger: 'document.approved', documentId },
        });
        expect(evaluation.statusCode).toBe(200);
        const result = evaluation.json<{
          plans: Array<{ matched: boolean }>;
          runs: Array<{ status: string; matched: boolean; actions: unknown[] }>;
        }>();
        expect(
          await harness.db.one('SELECT deleted_at FROM documents WHERE id = ?', [documentId]),
        ).toEqual({ deleted_at: null });
        expect(result.plans[0]!.matched).toBe(false);
        expect(result.runs[0]).toMatchObject({ matched: false, status: 'skipped', actions: [] });
      },
    );

    it.each(['auto_approve', 'always_ask'])(
      'does not delete for an absent documented path under %s',
      async (policy) => {
        const account = await registerAccount(harness);
        const created = await createWorkflow(account, {
          name: 'Documented absent path',
          conditions: [{ field: 'total.amount', operator: 'not_equals', value: 0 }],
          approvalPolicy: policy,
          actions: [{ type: 'delete_document' }],
        });
        expect(created.statusCode).toBe(201);
        const documentId = await approvedInvoice(account);
        const evaluation = await harness.api.json('POST', '/api/v1/workflows/evaluate', {
          token: account.accessToken,
          body: { trigger: 'document.approved', documentId },
        });
        expect(evaluation.statusCode).toBe(200);
        const run = evaluation.json<{ runs: Array<{ status: string; matched: boolean }> }>()
          .runs[0]!;
        expect(run).toMatchObject({ status: 'skipped', matched: false });
        expect(
          await harness.db.one('SELECT deleted_at FROM documents WHERE id = ?', [documentId]),
        ).toEqual({ deleted_at: null });
        expect(
          await harness.db.query('SELECT id FROM audit_logs WHERE action = ? AND target_id = ?', [
            'document.deleted',
            documentId,
          ]),
        ).toHaveLength(0);
      },
    );

    it('does not delete when a comparison operand was omitted', async () => {
      const account = await registerAccount(harness);
      const created = await createWorkflow(account, {
        name: 'Missing operand',
        conditions: [{ field: 'documentType', operator: 'not_equals' }],
        approvalPolicy: 'auto_approve',
        actions: [{ type: 'delete_document' }],
      });
      expect(created.statusCode).toBe(201);
      const documentId = await approvedInvoice(account);
      const evaluation = await harness.api.json('POST', '/api/v1/workflows/evaluate', {
        token: account.accessToken,
        body: { trigger: 'document.approved', documentId },
      });
      expect(evaluation.statusCode).toBe(200);
      expect(evaluation.json<{ runs: Array<{ status: string }> }>().runs[0]!.status).toBe(
        'skipped',
      );
      expect(
        await harness.db.one('SELECT deleted_at FROM documents WHERE id = ?', [documentId]),
      ).toEqual({ deleted_at: null });
    });

    it('characterizes the unresolved flat UDM path mismatch without executing the destructive action', async () => {
      const account = await registerAccount(harness);
      const documented = await createWorkflow(account, {
        name: 'Documented path',
        conditions: [{ field: 'total.amount', operator: 'greater_than', value: 100 }],
        actions: [{ type: 'delete_document', config: {} }],
      });
      const raw = await createWorkflow(account, {
        name: 'Current raw path',
        conditions: [{ field: 'fields.total.amount.value', operator: 'greater_than', value: 100 }],
        actions: [{ type: 'delete_document', config: {} }],
      });
      expect(documented.statusCode).toBe(201);
      expect(raw.statusCode).toBe(201);
      const documentId = await approvedInvoice(account);
      const evaluation = await harness.api.json('POST', '/api/v1/workflows/evaluate', {
        token: account.accessToken,
        body: { trigger: 'document.approved', documentId },
      });
      expect(evaluation.statusCode).toBe(200);
      const runs = evaluation.json<{
        runs: Array<{ workflowId: string; status: string; matched: boolean }>;
      }>().runs;
      // This describes the current defect, not a specification for correct field semantics.
      expect(
        runs.find((run) => run.workflowId === documented.json<{ id: string }>().id),
      ).toMatchObject({
        status: 'skipped',
        matched: false,
      });
      expect(runs.find((run) => run.workflowId === raw.json<{ id: string }>().id)).toMatchObject({
        status: 'awaiting_approval',
        matched: true,
      });
      expect(
        await harness.db.one('SELECT deleted_at FROM documents WHERE id = ?', [documentId]),
      ).toEqual({ deleted_at: null });
    });

    it('does not report a successful deletion for a run without a document', async () => {
      const account = await registerAccount(harness);
      const created = await createWorkflow(account, {
        trigger: 'batch.completed',
        approvalPolicy: 'auto_approve',
        actions: [{ type: 'delete_document', config: {} }],
      });
      expect(created.statusCode).toBe(201);
      const evaluation = await harness.api.json('POST', '/api/v1/workflows/evaluate', {
        token: account.accessToken,
        body: { trigger: 'batch.completed' },
      });
      const run = evaluation.json<{
        runs: Array<{ status: string; outputs: string[]; failure: string }>;
      }>().runs[0]!;
      expect(run.status).toBe('failed');
      expect(run.outputs).toEqual([]);
      expect(run.failure).toMatch(/Batch-trigger document deletion is unavailable/);
    });

    it('logs the workflows that did not match, with the reason', async () => {
      const account = await registerAccount(harness);
      await createWorkflow(account, {
        name: 'Only receipts',
        documentType: 'receipt',
      });
      const documentId = await approvedInvoice(account);

      const evaluation = await harness.api.json('POST', '/api/v1/workflows/evaluate', {
        token: account.accessToken,
        body: { trigger: 'document.approved', documentId },
      });
      const run = evaluation.json<{
        runs: Array<{ status: string; matched: boolean; explanation: string }>;
      }>().runs[0]!;
      expect(run.status).toBe('skipped');
      expect(run.matched).toBe(false);
      expect(run.explanation).toMatch(/Applies to receipt/);
    });

    it('requires an owner to create a self-approving workflow, and an admin for any workflow', async () => {
      const account = await registerAccount(harness);
      const invited = await harness.api.json('POST', '/api/v1/users/invite', {
        token: account.accessToken,
        body: { email: 'workflow-reviewer@example.com', role: 'reviewer' },
      });
      expect(invited.statusCode).toBe(202);
      const reviewer = await acceptInviteFor(harness, 'workflow-reviewer@example.com');

      const asReviewer = await createWorkflow(reviewer);
      expect(asReviewer.statusCode).toBe(403);

      const autoApprove = await createWorkflow(account, {
        name: 'Auto send',
        approvalPolicy: 'auto_approve',
        actions: [{ type: 'send_to_connector', config: {} }],
      });
      // The registering account is the owner, so this succeeds — and the policy is recorded.
      expect(autoApprove.statusCode).toBe(201);
      expect(autoApprove.json<{ approvalPolicy: string }>().approvalPolicy).toBe('auto_approve');
    });

    it('rejects an unknown trigger or action instead of storing a rule that cannot run', async () => {
      const account = await registerAccount(harness);
      const badTrigger = await createWorkflow(account, { trigger: 'document.exploded' });
      expect(badTrigger.statusCode).toBe(400);

      const badAction = await createWorkflow(account, { actions: [{ type: 'launch_rockets' }] });
      expect(badAction.statusCode).toBe(400);

      const noActions = await createWorkflow(account, { actions: [] });
      expect(noActions.statusCode).toBe(400);
      expect(noActions.body).toMatch(/at least one action/i);
    });

    it('deletes a rule but keeps the history of what it did', async () => {
      const account = await registerAccount(harness);
      const created = await createWorkflow(account, { name: 'Temporary' });
      const workflowId = created.json<{ id: string }>().id;
      const documentId = await approvedInvoice(account);
      await harness.api.json('POST', '/api/v1/workflows/evaluate', {
        token: account.accessToken,
        body: { trigger: 'document.approved', documentId },
      });

      const deleted = await harness.api.json('DELETE', `/api/v1/workflows/${workflowId}`, {
        token: account.accessToken,
      });
      expect(deleted.statusCode).toBe(204);

      const remaining = await harness.db.one<{ count: number }>(
        'SELECT COUNT(*) AS count FROM workflow_runs WHERE workflow_id = ?',
        [workflowId],
      );
      expect(Number(remaining?.count ?? 0)).toBeGreaterThan(0);
    });
  });
});

/** Invitations are accepted by setting a password directly, as the other helpers do. */
async function acceptInviteFor(harness: Harness, email: string): Promise<TestAccount> {
  const row = await harness.db.one<{ id: string; organisation_id: string }>(
    `SELECT u.id, m.organisation_id FROM users u JOIN memberships m ON m.user_id = u.id
      WHERE u.email = ?`,
    [email],
  );
  if (!row) throw new Error(`no invited user ${email}`);
  const password = 'correct horse battery staple';
  const hash = await harness.services.hasher.hash(password);
  await harness.db.execute('UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?', [
    hash,
    new Date().toISOString(),
    row.id,
  ]);
  await harness.db.execute(
    'UPDATE memberships SET accepted_at = ? WHERE user_id = ? AND organisation_id = ?',
    [new Date().toISOString(), row.id, row.organisation_id],
  );
  const login = await harness.api.json('POST', '/api/v1/auth/login', {
    body: { email, password },
  });
  const body = login.json<{ accessToken: string; refreshToken: string; user: { id: string } }>();
  return {
    accessToken: body.accessToken,
    refreshToken: body.refreshToken,
    userId: body.user.id,
    organisationId: row.organisation_id,
    email,
  };
}
