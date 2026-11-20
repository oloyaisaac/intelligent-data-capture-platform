import { resolve } from 'node:path';
import { ConnectorRegistry, type Connector } from '@idcp/connectors';
import { ConnectorProcess } from '../src/adapters/connector-process';
import { ProcessConnectorRegistry } from '../src/adapters/process-connector-registry';
import { createHarness, registerAccount } from './helpers';

it('survives a fatal child during a real connector API request', async () => {
  const neverInHost = () => {
    throw new Error('Connector implementation ran in the host');
  };
  const descriptor: Connector = {
    type: 'csv',
    label: 'Test',
    capabilities: ['create'],
    validateConfig: neverInHost,
    healthCheck: neverInHost,
    describeSchema: neverInHost,
    create: neverInHost,
  };
  const transport = new ConnectorProcess(
    process.execPath,
    [resolve(__dirname, 'fixtures/connector-process-child.js')],
    {
      maxConcurrent: 1,
      timeoutMs: 5000,
      maxInputBytes: 4096,
      maxOutputBytes: 4096,
    },
  );
  const registry = new ProcessConnectorRegistry(new ConnectorRegistry([descriptor]), transport);
  const harness = await createHarness({}, { registry });
  try {
    const account = await registerAccount(harness);
    const created = await harness.api.json('POST', '/api/v1/connectors', {
      token: account.accessToken,
      body: { type: 'csv', name: 'Fatal child', config: { token: 'synthetic-secret' } },
    });
    expect(created.statusCode).toBe(201);
    const id = created.json<{ id: string }>().id;
    const tested = await harness.api.json('POST', `/api/v1/connectors/${id}/test`, {
      token: account.accessToken,
    });
    expect(tested.statusCode).toBe(200);
    expect(tested.json()).toMatchObject({ ok: false });
    expect(tested.body).not.toContain('synthetic-secret');
    expect((await harness.api.get('/api/v1/health')).statusCode).toBe(200);
  } finally {
    await harness.close();
  }
});
