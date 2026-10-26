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

      // A non-destructive action completes immediately; the log says what it did.
      const runs = await harness.api.json('GET', '/api/v1/workflows/runs', {
        token: account.accessToken,
      });
      const run = runs.json<{
        items: Array<{ status: string; outputs: string[]; explanation: string }>;
      }>().items[0]!;
      expect(run.status).toBe('completed');
      expect(run.outputs.join(' ')).toMatch(/notified: Invoice approved/);
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
      expect(approved.statusCode).toBe(200);
      const completed = approved.json<{ status: string; outputs: string[]; approvedBy: string }>();
      expect(completed.status).toBe('completed');
      expect(completed.approvedBy).toBe(account.userId);
      expect(completed.outputs.join(' ')).toMatch(/send queued for connector conn-9/);

      // Approving twice is a conflict, not a second write.
      const twice = await harness.api.json('POST', `/api/v1/workflows/runs/${run.id}/approve`, {
        token: account.accessToken,
      });
      expect(twice.statusCode).toBe(409);
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
