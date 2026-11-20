import { AppError } from '@idcp/shared';
import { createLogger } from '../src/logger';
import { createHarness, registerAccount } from './helpers';

it.each([
  new Error('SECRET-REGISTRY-FAILURE'),
  new AppError('FORBIDDEN', 'SECRET-REGISTRY-FAILURE'),
  { detail: 'SECRET-REGISTRY-FAILURE' },
  null,
])('masks connector registry errors during creation', async (failure) => {
  const logs: string[] = [];
  const registry = {
    list: () => [],
    get: () => {
      throw failure;
    },
  };
  const harness = await createHarness(
    {},
    { registry, logger: createLogger({ level: 'debug', sink: (line) => logs.push(line) }) },
  );
  try {
    const account = await registerAccount(harness);
    const response = await harness.api.json('POST', '/api/v1/connectors', {
      token: account.accessToken,
      body: { type: 'csv', name: 'synthetic', config: {} },
    });
    expect(response.statusCode).toBe(400);
    expect(response.body).toContain('The requested connector type is unavailable.');
    expect(response.body).not.toContain('SECRET-REGISTRY-FAILURE');
    expect(logs.join('\n')).not.toContain('SECRET-REGISTRY-FAILURE');
    expect(await harness.db.query('SELECT id FROM connectors')).toHaveLength(0);
  } finally {
    await harness.close();
  }
});
