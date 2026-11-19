import { ConnectorRegistry, type Connector } from '@idcp/connectors';
import { createHarness, registerAccount } from './helpers';

it('encrypts arbitrary config and credentials, returns neither, and validates their merged values', async () => {
  const token = 'synthetic-config-token-7319';
  const arbitrarySecret = 'synthetic-nested-config-secret-2485';
  const harness = await createHarness();
  try {
    const account = await registerAccount(harness);
    const create = (config: Record<string, unknown>, credentials?: Record<string, string>) =>
      harness.api.json('POST', '/api/v1/connectors', {
        token: account.accessToken,
        body: { type: 'hubspot', name: 'Secure config', config, credentials },
      });
    const response = await create({ nested: { anyKey: arbitrarySecret } }, { token });
    expect(response.statusCode).toBe(201);
    expect(response.json<{ config: unknown }>().config).toEqual({});
    expect(response.body).not.toContain(token);
    expect(response.body).not.toContain(arbitrarySecret);
    const id = response.json<{ id: string }>().id;
    const stored = await harness.db.one<{ config: string; credentials_encrypted: string | null }>(
      'SELECT config, credentials_encrypted FROM connectors WHERE id = ?',
      [id],
    );
    expect(stored?.credentials_encrypted).toBeTruthy();
    expect(JSON.stringify(stored)).not.toContain(token);
    expect(JSON.stringify(stored)).not.toContain(arbitrarySecret);
    const listed = await harness.api.get('/api/v1/connectors', account.accessToken);
    expect(listed.body).not.toContain(token);
    expect(listed.body).not.toContain(arbitrarySecret);
    // Credential overrides are validated before persistence, rather than just during use.
    const configOnly = await create({ token });
    expect(configOnly.statusCode).toBe(201);
    expect(configOnly.body).not.toContain(token);
    const configOnlyRow = await harness.db.one<{ config: string; credentials_encrypted: string }>(
      'SELECT config, credentials_encrypted FROM connectors WHERE id = ?',
      [configOnly.json<{ id: string }>().id],
    );
    expect(JSON.stringify(configOnlyRow)).not.toContain(token);
    const invalid = await create({ token }, { baseUrl: 'https://127.0.0.1' });
    expect(invalid.statusCode).toBe(400);
  } finally {
    await harness.close();
  }
});

it('preserves legacy invocation and credential precedence, redacts legacy DTOs, and encrypts config on replacement', async () => {
  const validateConfig = jest.fn();
  const healthCheck = jest.fn().mockResolvedValue({ ok: true });
  const connector: Connector = {
    type: 'csv',
    label: 'Test',
    capabilities: ['create'],
    validateConfig,
    healthCheck,
    describeSchema: async () => ({ container: 'test', fields: [] }),
    create: async () => ({ created: 0, updated: 0, skipped: 0, summary: 'ok' }),
  };
  const harness = await createHarness({}, { registry: new ConnectorRegistry([connector]) });
  try {
    const account = await registerAccount(harness);
    const created = await harness.api.json('POST', '/api/v1/connectors', {
      token: account.accessToken,
      body: {
        type: 'csv',
        name: 'Legacy',
        config: { field: 'initial' },
        credentials: { token: 'credential-priority' },
      },
    });
    expect(created.statusCode).toBe(201);
    const id = created.json<{ id: string }>().id;
    // Simulate a pre-upgrade row with encrypted credentials and plaintext config.
    const row = await harness.db.one<{ credentials_encrypted: string }>(
      'SELECT credentials_encrypted FROM connectors WHERE id = ?',
      [id],
    );
    // Extract legacy credentials using the same configured box, via an independently created legacy fixture below.
    const { createSecretBox } = await import('../src/services/crypto');
    const legacyCredentials = createSecretBox(harness.config.ENCRYPTION_KEY).encrypt(
      JSON.stringify({ token: 'credential-priority' }),
      account.organisationId,
    );
    expect(row?.credentials_encrypted).toBeTruthy();
    await harness.db.execute(
      'UPDATE connectors SET config = ?, credentials_encrypted = ? WHERE id = ?',
      [JSON.stringify({ field: 'old-secret', token: 'low-priority' }), legacyCredentials, id],
    );
    const list = await harness.api.get('/api/v1/connectors', account.accessToken);
    expect(list.body).not.toContain('old-secret');
    expect(list.body).not.toContain('low-priority');
    const checked = await harness.api.json('POST', `/api/v1/connectors/${id}/test`, {
      token: account.accessToken,
    });
    expect(checked.json()).toEqual({ ok: true });
    expect(healthCheck).toHaveBeenLastCalledWith(
      expect.objectContaining({ field: 'old-secret', token: 'credential-priority' }),
      expect.anything(),
    );
    const patched = await harness.api.json('PATCH', `/api/v1/connectors/${id}`, {
      token: account.accessToken,
      body: { config: { field: 'new-secret', token: 'still-low-priority' } },
    });
    expect(patched.statusCode).toBe(200);
    expect(patched.body).not.toContain('new-secret');
    expect(validateConfig).toHaveBeenLastCalledWith(
      expect.objectContaining({ field: 'new-secret', token: 'credential-priority' }),
    );
    const updated = await harness.db.one<{ config: string; credentials_encrypted: string }>(
      'SELECT config, credentials_encrypted FROM connectors WHERE id = ?',
      [id],
    );
    expect(JSON.stringify(updated)).not.toContain('new-secret');
    expect(JSON.stringify(updated)).not.toContain('credential-priority');
    await harness.api.json('POST', `/api/v1/connectors/${id}/test`, { token: account.accessToken });
    expect(healthCheck).toHaveBeenLastCalledWith(
      expect.objectContaining({ field: 'new-secret', token: 'credential-priority' }),
      expect.anything(),
    );
  } finally {
    await harness.close();
  }
});
