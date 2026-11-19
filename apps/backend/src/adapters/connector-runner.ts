import { ConnectorRegistry, type ConnectorContext } from '@idcp/connectors';
import { z } from 'zod';

// A separate process is not an OS security boundary. Do not accept arbitrary code paths here.
const MAX_INPUT_BYTES = 2 * 1024 * 1024;
const Scalar = z.union([z.string(), z.number().finite(), z.boolean(), z.null()]);
const Query = z.object({
  limit: z.number().int().optional(),
  where: z.record(z.string(), z.union([z.string(), z.number().finite(), z.boolean()])).optional(),
});
const Request = z.object({
  type: z.string(),
  operation: z.enum([
    'validateConfig',
    'healthCheck',
    'describeSchema',
    'create',
    'read',
    'search',
    'update',
  ]),
  organisationId: z.string(),
  config: z.record(z.string(), z.unknown()),
  records: z.array(z.object({ values: z.record(z.string(), Scalar) })).optional(),
  keys: z.array(z.string()).optional(),
  query: Query.optional(),
});

function respond(value: unknown): void {
  process.stdout.write(JSON.stringify(value), () => process.exit(0));
}

async function execute(input: unknown): Promise<unknown> {
  const request = Request.parse(input);
  const connector = new ConnectorRegistry().get(request.type);
  const context: ConnectorContext = {
    organisationId: request.organisationId,
    // Do not forward connector-provided diagnostics to the host or protocol output.
    logger: {
      debug: () => undefined,
      info: () => undefined,
      warn: () => undefined,
      error: () => undefined,
    },
  };
  switch (request.operation) {
    case 'validateConfig':
      connector.validateConfig(request.config);
      return null;
    case 'healthCheck':
      return connector.healthCheck(request.config, context);
    case 'describeSchema':
      return connector.describeSchema(request.config, context);
    case 'create':
      if (!request.records) throw new Error('Missing records');
      return connector.create(request.records, request.config, context);
    case 'read':
      if (!connector.read || !request.query) throw new Error('Unsupported operation');
      return connector.read(request.query, request.config, context);
    case 'search':
      if (!connector.search || !request.query) throw new Error('Unsupported operation');
      return connector.search(request.query, request.config, context);
    case 'update':
      if (!connector.update || !request.records || !request.keys)
        throw new Error('Unsupported operation');
      return connector.update(request.records, request.keys, request.config, context);
  }
}

let total = 0;
let ended = false;
const chunks: Buffer[] = [];
process.stdin.on('data', (chunk: Buffer) => {
  if (ended) return;
  total += chunk.length;
  if (total > MAX_INPUT_BYTES) {
    ended = true;
    respond({ ok: false });
    return;
  }
  chunks.push(chunk);
});
process.stdin.on('error', () => {
  if (!ended) {
    ended = true;
    respond({ ok: false });
  }
});
process.stdin.on('end', () => {
  if (ended) return;
  ended = true;
  void (async () => {
    try {
      const input: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      const value = await execute(input);
      respond({ ok: true, value });
    } catch {
      // Error text can contain credentials or destination data.
      respond({ ok: false });
    }
  })();
});
