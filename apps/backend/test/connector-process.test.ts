import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { ConnectorProcess } from '../src/adapters/connector-process';

const fixture = resolve(__dirname, 'fixtures/connector-process-child.js');
const runner = resolve(__dirname, '../src/adapters/connector-runner.ts');
const limits = { maxConcurrent: 1, timeoutMs: 3000, maxInputBytes: 2048, maxOutputBytes: 2048 };

it('round-trips bounded data without inheriting the parent environment', async () => {
  const previous = process.env.IDCP_TEST_INHERITED_SECRET;
  process.env.IDCP_TEST_INHERITED_SECRET = 'synthetic-parent-secret';
  try {
    const transport = new ConnectorProcess(process.execPath, [fixture], limits);
    await expect(transport.invoke({ value: { hello: 'world' } })).resolves.toEqual({
      hello: 'world',
    });
    await expect(transport.invoke({ action: 'secret' })).resolves.toBeNull();
  } finally {
    if (previous === undefined) delete process.env.IDCP_TEST_INHERITED_SECRET;
    else process.env.IDCP_TEST_INHERITED_SECRET = previous;
  }
});

it('rejects crashes, malformed responses, excessive output and child errors without leaking messages', async () => {
  for (const action of ['exit', 'invalid', 'flood', 'error']) {
    const transport = new ConnectorProcess(process.execPath, [fixture], limits);
    await expect(transport.invoke({ action, secret: 'synthetic-sensitive-value' })).rejects.toThrow(
      'Connector invocation failed',
    );
  }
});

it('limits input and concurrent execution, kills a hung child and releases its slot', async () => {
  const transport = new ConnectorProcess(process.execPath, [fixture], {
    ...limits,
    timeoutMs: 1500,
  });
  await expect(transport.invoke({ value: 'x'.repeat(3000) })).rejects.toThrow(
    'Connector invocation failed',
  );
  const hung = transport.invoke({ action: 'hang' });
  const rejected = expect(hung).rejects.toThrow('Connector invocation failed');
  await expect(transport.invoke({ value: 'busy' })).rejects.toThrow('Connector invocation busy');
  await rejected;
  // The promise rejects on timeout; its slot is released only when the child has actually closed.
  // Wait for that OS event rather than assuming the process reaps within a fixed short delay.
  const deadline = Date.now() + 5000;
  for (;;) {
    try {
      expect(await transport.invoke({ value: 'after' })).toBe('after');
      break;
    } catch (error) {
      if (
        !(error instanceof Error) ||
        error.message !== 'Connector invocation busy' ||
        Date.now() >= deadline
      )
        throw error;
      await new Promise((resolveDone) => setTimeout(resolveDone, 25));
    }
  }
});

(process.platform === 'win32' ? it.skip : it)(
  'kills a same-process-group descendant when a hung connector times out',
  async () => {
    const directory = await mkdtemp(join(tmpdir(), 'idcp-connector-descendant-'));
    const marker = join(directory, 'marker');
    const pidFile = join(directory, 'pid');
    try {
      const transport = new ConnectorProcess(
        process.execPath,
        [resolve(__dirname, 'fixtures/connector-process-descendants.js')],
        { ...limits, timeoutMs: 1500 },
      );
      await expect(transport.invoke({ marker, pidFile })).rejects.toThrow(
        'Connector invocation failed',
      );
      const descendantPid = Number(await readFile(pidFile, 'utf8'));
      expect(Number.isInteger(descendantPid) && descendantPid > 0).toBe(true);
      // Wait beyond the synthetic descendant's delayed write; checking the PID alone can mistake a
      // terminated-but-unreaped process for a running descendant.
      await new Promise((done) => setTimeout(done, 1800));
      await expect(access(marker)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      // The synthetic descendant exits after its single delayed write, even if the assertion fails.
      await rm(directory, { recursive: true, force: true });
    }
  },
  15_000,
);

it('rejects invalid limits and non-serializable requests', async () => {
  expect(
    () => new ConnectorProcess(process.execPath, [fixture], { ...limits, maxConcurrent: 0 }),
  ).toThrow();
  const transport = new ConnectorProcess(process.execPath, [fixture], limits);
  const circular: { self?: unknown } = {};
  circular.self = circular;
  await expect(transport.invoke(circular)).rejects.toThrow('Connector invocation failed');
});

it('executes a first-party CSV connector in a real child process', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'idcp-connector-process-'));
  const transport = new ConnectorProcess(process.execPath, ['--import', 'tsx', runner], {
    ...limits,
    timeoutMs: 10_000,
  });
  const common = {
    type: 'csv',
    organisationId: 'synthetic-org',
    config: { directory, filename: 'out.csv' },
  };
  try {
    await expect(transport.invoke({ ...common, operation: 'validateConfig' })).resolves.toBeNull();
    await expect(transport.invoke({ ...common, operation: 'healthCheck' })).resolves.toEqual({
      ok: true,
    });
    await expect(
      transport.invoke({
        ...common,
        operation: 'create',
        records: [{ values: { name: 'Invoice 1' } }],
      }),
    ).resolves.toMatchObject({ created: 1 });
    await expect(
      transport.invoke({ ...common, operation: 'read', query: { limit: 10 } }),
    ).resolves.toEqual([{ values: { name: 'Invoice 1' } }]);
    expect(await readFile(join(directory, 'out.csv'), 'utf8')).toContain('Invoice 1');
    await expect(transport.invoke({ ...common, operation: 'search', query: {} })).rejects.toThrow(
      'Connector invocation failed',
    );
    await expect(
      transport.invoke({
        ...common,
        operation: 'validateConfig',
        config: { directory, filename: '../secret' },
      }),
    ).rejects.toThrow('Connector invocation failed');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}, 30_000);

it('preserves existing CSV bytes and refuses malformed data in the real connector child', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'idcp-connector-csv-append-'));
  const file = join(directory, 'out.csv');
  const transport = new ConnectorProcess(process.execPath, ['--import', 'tsx', runner], {
    ...limits,
    timeoutMs: 10_000,
  });
  const request = {
    type: 'csv',
    organisationId: 'synthetic-org',
    config: { directory, filename: 'out.csv' },
    operation: 'create',
    records: [{ values: { name: 'new' } }],
  };
  try {
    const prior = 'name\n=1+1\n';
    await writeFile(file, prior);
    await expect(transport.invoke(request)).resolves.toMatchObject({ created: 1 });
    expect(await readFile(file, 'utf8')).toBe(`${prior}new\r\n`);
    const malformed = 'name\n"unterminated';
    await writeFile(file, malformed);
    await expect(transport.invoke(request)).rejects.toThrow('Connector invocation failed');
    expect(await readFile(file, 'utf8')).toBe(malformed);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}, 30_000);
