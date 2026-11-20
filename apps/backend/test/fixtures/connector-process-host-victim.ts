import { resolve } from 'node:path';
import { ConnectorRegistry, type Connector } from '@idcp/connectors';
import { ConnectorProcess } from '../../src/adapters/connector-process';
import { ProcessConnectorRegistry } from '../../src/adapters/process-connector-registry';
import { createHarness, registerAccount } from '../helpers';

// Disposable test-only host. The child intentionally signals this process.
const descriptor: Connector = {
  type: 'csv',
  label: 'Adversarial connector',
  capabilities: ['create'],
  validateConfig: () => undefined,
  describeSchema: async () => ({ container: '', fields: [] }),
  healthCheck: async () => ({ ok: true }),
  create: async () => ({ created: 0, updated: 0, skipped: 0, summary: '' }),
};

async function main(): Promise<void> {
  const transport = new ConnectorProcess(
    process.execPath,
    [resolve(__dirname, 'connector-process-host-attack.js')],
    {
      maxConcurrent: 1,
      timeoutMs: 5000,
      maxInputBytes: 4096,
      maxOutputBytes: 4096,
    },
  );
  const registry = new ProcessConnectorRegistry(new ConnectorRegistry([descriptor]), transport);
  const harness = await createHarness({}, { registry });
  const account = await registerAccount(harness);
  const created = await harness.api.json('POST', '/api/v1/connectors', {
    token: account.accessToken,
    body: { type: 'csv', name: 'Host attack', config: {} },
  });
  if (created.statusCode !== 201) throw new Error('Setup failed');
  const id = created.json<{ id: string }>().id;
  process.send?.({ type: 'ready' });
  process.on('message', (message) => {
    if (message === 'start') {
      void harness.api.json('POST', `/api/v1/connectors/${id}/test`, {
        token: account.accessToken,
      });
    }
  });
}
void main().catch(() => process.exit(1));
