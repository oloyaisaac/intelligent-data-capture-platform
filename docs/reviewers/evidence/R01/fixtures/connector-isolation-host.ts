// Evidence-only host for the P8 probe. Uses the real ConnectorProcess transport; no HTTP stack.
import { ConnectorProcess } from '../../../../../apps/backend/src/adapters/connector-process';

const [script, mode] = process.argv.slice(2);
if (!script || !mode || !process.send) throw new Error('script, mode and IPC are required');

const transport = new ConnectorProcess(process.execPath, [script], {
  maxConcurrent: 1,
  timeoutMs: 3000,
  maxInputBytes: 4096,
  maxOutputBytes: 4096,
});

process.on('message', (message) => {
  if (message !== 'start') return;
  void transport
    .invoke({ operation: 'healthCheck' })
    .then((value) => {
      process.send?.({ type: 'settled', value });
      // The probe only needs the transport's verdict; exit so the host is not left idle.
      setImmediate(() => process.exit(0));
    })
    .catch((error: unknown) => {
      process.send?.({ type: 'rejected', message: String((error as Error).message) });
      setImmediate(() => process.exit(0));
    });
});
process.send?.({ type: 'ready' });
