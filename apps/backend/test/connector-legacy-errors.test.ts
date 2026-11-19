import { createHarness, registerAccount } from './helpers';

it('does not return untrusted historical connector errors in list, update or run history', async () => {
  const harness = await createHarness();
  const secret = 'legacy-destination-error-secret-3192';
  try {
    const account = await registerAccount(harness);
    const created = await harness.api.json('POST', '/api/v1/connectors', {
      token: account.accessToken,
      body: {
        type: 'csv',
        name: 'Legacy errors',
        config: { directory: '/tmp', filename: 'a.csv' },
      },
    });
    expect(created.statusCode).toBe(201);
    const id = created.json<{ id: string }>().id;
    await harness.db.execute('UPDATE connectors SET status = ?, last_error = ? WHERE id = ?', [
      'error',
      `old health error ${secret}`,
      id,
    ]);
    await harness.db.execute(
      `INSERT INTO connector_runs (id, organisation_id, connector_id, operation, status, error, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        'old-run',
        account.organisationId,
        id,
        'create',
        'failed',
        `old error ${secret}`,
        new Date().toISOString(),
      ],
    );
    const list = await harness.api.get('/api/v1/connectors', account.accessToken);
    expect(list.statusCode).toBe(200);
    expect(list.body).not.toContain(secret);
    expect(list.json<{ items: { lastError: string }[] }>().items[0]!.lastError).toContain(
      'connection settings',
    );
    const updated = await harness.api.json('PATCH', `/api/v1/connectors/${id}`, {
      token: account.accessToken,
      body: { name: 'Updated' },
    });
    expect(updated.statusCode).toBe(200);
    expect(updated.body).not.toContain(secret);
    const runs = await harness.api.get(`/api/v1/connectors/${id}/runs`, account.accessToken);
    expect(runs.statusCode).toBe(200);
    expect(runs.body).not.toContain(secret);
    expect(runs.json<{ items: { error: string }[] }>().items[0]!.error).toContain(
      'destination for changes',
    );
    // Historical values remain in storage; this is response hardening, not data cleanup.
    const row = await harness.db.one<{ last_error: string }>(
      'SELECT last_error FROM connectors WHERE id = ?',
      [id],
    );
    expect(row?.last_error).toContain(secret);
  } finally {
    await harness.close();
  }
});
