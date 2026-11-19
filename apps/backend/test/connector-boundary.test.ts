import { ConnectorRegistry, type Connector, type ConnectorContext } from '@idcp/connectors';
import { AppError } from '@idcp/shared';
import { createLogger } from '../src/logger';
import { createHarness, registerAccount } from './helpers';

/** Ordinary connector failures only; this is not an isolation boundary against hostile code. */
it('protects validation and health-check responses, persistence and logs from connector details', async () => {
  const secret = 'connector-private-secret-9753';
  const logs: string[] = [];
  const validateConfig = jest.fn();
  const healthCheck = jest.fn();
  const describeSchema = jest.fn();
  const connector: Connector = {
    type: 'csv',
    label: 'Boundary test connector',
    capabilities: ['create'],
    validateConfig,
    healthCheck,
    describeSchema,
    create: async () => ({ created: 0, updated: 0, skipped: 0, summary: 'done' }),
  };
  const logger = createLogger({ level: 'debug', sink: (line) => logs.push(line) });
  const harness = await createHarness({}, { registry: new ConnectorRegistry([connector]), logger });
  try {
    const account = await registerAccount(harness);
    const create = () =>
      harness.api.json('POST', '/api/v1/connectors', {
        token: account.accessToken,
        body: { type: 'csv', name: 'Destination', config: {} },
      });
    validateConfig.mockImplementationOnce(() => {
      throw new Error(`validation ${secret}`);
    });
    const invalid = await create();
    expect(invalid.statusCode).toBe(400);
    expect(invalid.body).not.toContain(secret);
    expect(invalid.json()).toMatchObject({ error: { code: 'FIELD_VALIDATION_FAILED' } });

    const created = await create();
    expect(created.statusCode).toBe(201);
    const connectorId = created.json<{ id: string }>().id;
    validateConfig.mockImplementationOnce(() => {
      throw new AppError('FORBIDDEN', `patch ${secret}`);
    });
    const patch = await harness.api.json('PATCH', `/api/v1/connectors/${connectorId}`, {
      token: account.accessToken,
      body: { config: { safe: true } },
    });
    expect(patch.statusCode).toBe(400);
    expect(patch.body).not.toContain(secret);

    describeSchema.mockRejectedValueOnce(new AppError('FORBIDDEN', `schema ${secret}`));
    describeSchema.mockResolvedValueOnce({ container: 'test', fields: [] });
    const schemaFailure = await harness.api.get(
      `/api/v1/connectors/${connectorId}/schema`,
      account.accessToken,
    );
    expect(schemaFailure.statusCode).toBe(422);
    expect(schemaFailure.body).not.toContain(secret);
    const schemaSuccess = await harness.api.get(
      `/api/v1/connectors/${connectorId}/schema`,
      account.accessToken,
    );
    expect(schemaSuccess.statusCode).toBe(200);
    expect(schemaSuccess.json()).toEqual({ container: 'test', fields: [] });

    healthCheck.mockImplementationOnce(async (_config: unknown, context: ConnectorContext) => {
      context.logger.info(`message ${secret}`, { data: secret });
      context.logger.warn(`message ${secret}`, { data: secret });
      context.logger.error(`message ${secret}`, { data: secret });
      context.logger.debug(`message ${secret}`, { data: secret });
      return { ok: false, error: `returned ${secret}` };
    });
    healthCheck.mockRejectedValueOnce(new AppError('FORBIDDEN', `thrown ${secret}`));
    healthCheck.mockResolvedValueOnce({ ok: true, error: `extraneous ${secret}` });
    const check = () =>
      harness.api.json('POST', `/api/v1/connectors/${connectorId}/test`, {
        token: account.accessToken,
      });
    for (let i = 0; i < 2; i += 1) {
      const response = await check();
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        ok: false,
        error: expect.stringContaining('connection settings'),
      });
      expect(response.body).not.toContain(secret);
      const row = await harness.db.one<{ status: string; last_error: string }>(
        'SELECT status, last_error FROM connectors WHERE id = ?',
        [connectorId],
      );
      expect(row?.status).toBe('error');
      expect(row?.last_error).not.toContain(secret);
    }
    const recovered = await check();
    expect(recovered.statusCode).toBe(200);
    expect(recovered.json()).toEqual({ ok: true });
    const row = await harness.db.one<{ status: string; last_error: string | null }>(
      'SELECT status, last_error FROM connectors WHERE id = ?',
      [connectorId],
    );
    expect(row).toEqual({ status: 'active', last_error: null });
    const list = await harness.api.get('/api/v1/connectors', account.accessToken);
    expect(list.body).not.toContain(secret);
    expect(logs.join('\n')).not.toContain(secret);
    expect((await harness.api.json('GET', '/api/v1/health')).statusCode).toBe(200);
  } finally {
    await harness.close();
  }
});
