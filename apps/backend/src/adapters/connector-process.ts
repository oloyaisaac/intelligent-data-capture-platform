import { spawn } from 'node:child_process';

/**
 * Bounded one-shot subprocess transport. This is fault containment infrastructure, NOT a sandbox:
 * the child has the same OS privileges as the parent and may access files or the network directly.
 * The standard first-party registry uses it; explicitly injected registries can still run in-process.
 */
export class ConnectorProcess {
  private active = 0;

  constructor(
    private readonly executable: string,
    private readonly args: readonly string[],
    private readonly limits: {
      maxConcurrent: number;
      timeoutMs: number;
      maxInputBytes: number;
      maxOutputBytes: number;
    },
  ) {
    for (const value of Object.values(limits)) {
      if (!Number.isSafeInteger(value) || value < 1) throw new Error('Invalid process limit');
    }
  }

  async invoke(request: unknown): Promise<unknown> {
    let serialized: string;
    try {
      const encoded = JSON.stringify(request);
      if (typeof encoded !== 'string') throw new Error('Invalid request');
      serialized = encoded;
    } catch {
      throw new Error('Connector invocation failed');
    }
    if (Buffer.byteLength(serialized) > this.limits.maxInputBytes) {
      throw new Error('Connector invocation failed');
    }
    if (this.active >= this.limits.maxConcurrent) throw new Error('Connector invocation busy');

    let child;
    try {
      child = spawn(this.executable, [...this.args], {
        env: {},
        stdio: ['pipe', 'pipe', 'ignore'],
        windowsHide: true,
      });
    } catch {
      throw new Error('Connector invocation failed');
    }
    this.active += 1;

    return new Promise<unknown>((resolve, reject) => {
      let settled = false;
      let outputBytes = 0;
      const chunks: Buffer[] = [];
      let failed = false;
      const fail = () => {
        failed = true;
        if (!settled) {
          settled = true;
          reject(new Error('Connector invocation failed'));
        }
        // Keep the concurrency slot until the OS reports the process closed.
        try {
          if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
        } catch {
          // The slot remains occupied until the close event if termination fails.
        }
      };
      const timer = setTimeout(fail, this.limits.timeoutMs);
      timer.unref();
      child.once('error', fail);
      child.stdin.on('error', fail);
      child.stdout.on('error', fail);
      child.stdout.on('data', (chunk: Buffer) => {
        if (failed) return;
        outputBytes += chunk.length;
        if (outputBytes > this.limits.maxOutputBytes) {
          fail();
          return;
        }
        chunks.push(chunk);
      });
      child.once('close', (code, signal) => {
        clearTimeout(timer);
        this.active -= 1;
        if (settled) return;
        if (failed || code !== 0 || signal !== null) {
          fail();
          return;
        }
        try {
          const response: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          if (!response || typeof response !== 'object' || Array.isArray(response)) {
            throw new Error('Invalid response');
          }
          const message = response as Record<string, unknown>;
          if (message.ok !== true || !Object.hasOwn(message, 'value')) {
            throw new Error('Invalid response');
          }
          settled = true;
          resolve(message.value);
        } catch {
          fail();
        }
      });
      child.stdin.end(serialized);
    });
  }
}
