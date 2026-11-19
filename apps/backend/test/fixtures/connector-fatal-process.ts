import { ConnectorRegistry, type Connector } from '@idcp/connectors';
import { createHarness, registerAccount } from '../helpers';

// Test-only connector: intentionally terminates this disposable API process, not the Jest host.
const connector: Connector = {
  type: 'csv',
  label: 'Fatal connector fixture',
  capabilities: ['create'],
  validateConfig: () => undefined,
  describeSchema: async () => ({ container: 'test', fields: [] }),
  healthCheck: async () => {
    process.send?.({ type: 'connector-entered' }, () => process.exit(73));
    await new Promise<void>(() => undefined);
    return { ok: true };
  },
  create: async () => ({ created: 0, updated: 0, skipped: 0, summary: 'done' }),
};

async function run(): Promise<void> {
  const harness = await createHarness({}, { registry: new ConnectorRegistry([connector]) });
  const account = await registerAccount(harness);
  const created = await harness.api.json('POST', '/api/v1/connectors', {
    token: account.accessToken,
    body: { type: 'csv', name: 'Fatal test', config: {} },
  });
  if (created.statusCode !== 201) throw new Error('Fixture connector creation failed');
  const id = created.json<{ id: string }>().id;
  process.send?.({ type: 'ready' });
  process.on('message', (message) => {
    if (message !== 'start') return;
    void harness.api
      .json('POST', `/api/v1/connectors/${id}/test`, { token: account.accessToken })
      .then(
        () => process.send?.({ type: 'unexpected-response' }),
        () => process.send?.({ type: 'request-error' }),
      );
  });
}
void run().catch(() => {
  process.send?.({ type: 'fixture-error' });
  process.exitCode = 1;
});
