import { createHarness, registerAccount } from './helpers';

/** Characterizes an unresolved secret-exposure issue, not an acceptable security guarantee. */
it('documents that a HubSpot token in config is stored and returned as plaintext', async () => {
  const harness = await createHarness();
  const token = 'synthetic-config-token-7319';
  try {
    const account = await registerAccount(harness);
    const create = (config: Record<string, unknown>, credentials?: Record<string, string>) =>
      harness.api.json('POST', '/api/v1/connectors', {
        token: account.accessToken,
        body: { type: 'hubspot', name: 'Risk reproduction', config, credentials },
      });
    // Connector validation currently sees only config, not the supplied encrypted credentials.
    expect((await create({}, { token })).statusCode).toBe(400);
    const response = await create({ token });
    expect(response.statusCode).toBe(201);
    expect(response.body).toContain(token);
    const id = response.json<{ id: string }>().id;
    const stored = await harness.db.one<{ config: string; credentials_encrypted: string | null }>(
      'SELECT config, credentials_encrypted FROM connectors WHERE id = ?',
      [id],
    );
    expect(stored?.config).toContain(token);
    expect(stored?.credentials_encrypted).toBeNull();
    const listed = await harness.api.get('/api/v1/connectors', account.accessToken);
    expect(listed.statusCode).toBe(200);
    expect(listed.body).toContain(token);
  } finally {
    await harness.close();
  }
});
