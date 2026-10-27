import { createHarness, registerAccount, type Harness } from './helpers';

/**
 * The audit trail as a file (AUDIT-2026-10 §3).
 *
 * A customer's auditor asks for the log, not for a screenshot of it. The export is the same rows as
 * the JSON endpoint with the same permissions — the interesting assertions are the permission and
 * the fact that a spreadsheet cannot execute anything it finds in a cell.
 */
describe('audit log export', () => {
  let harness: Harness;

  beforeEach(async () => {
    harness = await createHarness();
  });

  afterEach(async () => {
    await harness.close();
  });

  it('gives an admin a CSV file of the organisation audit trail', async () => {
    const account = await registerAccount(harness, { email: 'auditor@example.com' });

    const response = await harness.api.json('GET', '/api/v1/audit-logs.csv', {
      token: account.accessToken,
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/csv');
    expect(response.headers.get('content-disposition')).toContain(
      'attachment; filename="audit-log-',
    );

    const body = response.body;
    expect(body.startsWith('\uFEFF')).toBe(true); // BOM, so Excel reads UTF-8
    const [header, firstRow] = body.replace(/^\uFEFF/, '').split('\r\n');
    expect(header).toBe('created_at,action,actor_type,actor_id,target_type,target_id,metadata');
    expect(firstRow).toContain('auth.register');

    // Writing the file is itself worth recording — in the trail, not in the file being written.
    const entry = await harness.db.one<{ action: string }>(
      `SELECT action FROM audit_logs WHERE action = 'audit.exported'`,
    );
    expect(entry?.action).toBe('audit.exported');
  });

  it('refuses the export to anyone below admin', async () => {
    const account = await registerAccount(harness, { email: 'reviewer@example.com' });
    await harness.db.execute('UPDATE memberships SET role = ? WHERE user_id = ?', [
      'reviewer',
      account.userId,
    ]);
    // The role is read from the session on every request, so re-login is not needed here.

    const response = await harness.api.json('GET', '/api/v1/audit-logs.csv', {
      token: account.accessToken,
    });
    expect(response.statusCode).toBe(403);
  });

  it('cannot be turned into a formula by a value in the log', async () => {
    const account = await registerAccount(harness, { email: 'formula@example.com' });
    await harness.db.execute(
      `INSERT INTO audit_logs (id, organisation_id, actor_type, actor_id, action, target_type, target_id, ip_hash, metadata, created_at)
       VALUES (?, ?, 'system', NULL, ?, NULL, NULL, NULL, '{}', ?)`,
      [
        'audit-formula',
        account.organisationId,
        '=HYPERLINK("http://evil.example","click")',
        new Date().toISOString(),
      ],
    );

    const response = await harness.api.json('GET', '/api/v1/audit-logs.csv', {
      token: account.accessToken,
    });
    expect(response.statusCode).toBe(200);
    // The apostrophe prefix is what stops the spreadsheet evaluating the cell.
    expect(response.body).toContain(`'=HYPERLINK`);
    expect(response.body).not.toMatch(/\r\n=HYPERLINK/);
  });
});
