import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { request as httpRequest } from 'node:http';
import type { MultipartFile } from '@fastify/multipart';
import { spoolBatchParts } from '../src/http/routes/batch-upload';
import { MAX_BATCH_FILES } from '../src/services/batch-service';
import {
  createHarness,
  drainWorker,
  fakePdf,
  fakePng,
  registerAccount,
  type Harness,
} from './helpers';

/**
 * BATCH-001 — batch upload.
 *
 * The point of a batch is that one bad file does not lose the other ninety-nine, so these tests
 * care as much about the failure path as the happy one.
 */
describe('BATCH-001 batch upload', () => {
  let harness: Harness;

  beforeEach(async () => {
    harness = await createHarness();
  });

  afterEach(async () => {
    await harness.close();
  });

  async function postBatch(
    token: string,
    files: Array<{ buffer: Buffer; filename: string }>,
    fields: Record<string, string> = {},
  ) {
    const form = new FormData();
    for (const [key, value] of Object.entries(fields)) form.append(key, value);
    for (const file of files) {
      form.append(
        'files',
        new Blob([new Uint8Array(file.buffer)], { type: 'image/png' }),
        file.filename,
      );
    }
    const response = await fetch(`${harness.baseUrl}/api/v1/batches`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}` },
      body: form,
    });
    return {
      statusCode: response.status,
      body: await response.text(),
      json: <T>() => JSON.parse(response.status === 204 ? '{}' : '') as T,
    };
  }

  it('accepts several files and creates one document per file', async () => {
    const account = await registerAccount(harness);
    const form = new FormData();
    form.append('name', 'Morning intake');
    form.append('documentType', 'invoice');
    for (const name of ['a.png', 'b.png', 'c.png']) {
      form.append('files', new Blob([new Uint8Array(fakePng(name))], { type: 'image/png' }), name);
    }

    const response = await fetch(`${harness.baseUrl}/api/v1/batches`, {
      method: 'POST',
      headers: { authorization: `Bearer ${account.accessToken}` },
      body: form,
    });
    expect(response.status).toBe(201);
    const batch = (await response.json()) as {
      id: string;
      name: string;
      total: number;
      processed: number;
      failed: number;
      status: string;
      items: Array<{ filename: string; documentId: string; status: string }>;
    };

    expect(batch.name).toBe('Morning intake');
    expect(batch.total).toBe(3);
    expect(batch.failed).toBe(0);
    expect(batch.items.map((item) => item.filename)).toEqual(['a.png', 'b.png', 'c.png']);
    expect(batch.items.every((item) => Boolean(item.documentId))).toBe(true);

    const documents = await harness.api.json('GET', '/api/v1/documents', {
      token: account.accessToken,
    });
    expect(documents.json<{ items: unknown[] }>().items).toHaveLength(3);
  });

  it('keeps the good files and records a failed item when one file is unsupported', async () => {
    const account = await registerAccount(harness);
    const response = await postBatch(account.accessToken, [
      { buffer: fakePng('good-1'), filename: 'good-1.png' },
      { buffer: Buffer.from('this is a text file, not a scan'), filename: 'notes.txt' },
      { buffer: fakePng('good-2'), filename: 'good-2.png' },
    ]);
    expect(response.statusCode).toBe(201);

    const batch = JSON.parse(response.body) as {
      total: number;
      failed: number;
      succeeded: number;
      status: string;
      items: Array<{ filename: string; status: string; error?: string; documentId: string | null }>;
    };
    expect(batch.total).toBe(3);
    expect(batch.failed).toBe(1);
    expect(batch.status).toBe('processing');

    const failed = batch.items.find((item) => item.filename === 'notes.txt');
    expect(failed?.status).toBe('failed');
    expect(failed?.documentId).toBeNull();
    expect(failed?.error).toMatch(/supported/i);
  });

  it('reports progress from the documents themselves once work finishes', async () => {
    const account = await registerAccount(harness);
    harness.ocr.setText('RECEIPT\nReceipt No: R-9\nTotal: UGX 1,000');
    const response = await postBatch(account.accessToken, [
      { buffer: fakePng('one'), filename: 'one.png' },
      { buffer: fakePdf('two'), filename: 'two.pdf' },
    ]);
    const batchId = (JSON.parse(response.body) as { id: string }).id;

    const queued = await harness.api.json('GET', `/api/v1/batches/${batchId}/items`, {
      token: account.accessToken,
    });
    expect(queued.json<{ processed: number; status: string }>().processed).toBe(0);
    expect(queued.json<{ status: string }>().status).toBe('processing');

    await drainWorker(harness);

    const done = await harness.api.json('GET', `/api/v1/batches/${batchId}/items`, {
      token: account.accessToken,
    });
    const progress = done.json<{
      processed: number;
      succeeded: number;
      status: string;
      items: Array<{ status: string }>;
    }>();
    expect(progress.processed).toBe(2);
    expect(progress.succeeded).toBe(2);
    expect(progress.status).toBe('completed');
    expect(progress.items.every((item) => item.status === 'succeeded')).toBe(true);
  });

  it('exports per-item results as CSV', async () => {
    const account = await registerAccount(harness);
    const response = await postBatch(account.accessToken, [
      { buffer: fakePng('csv'), filename: 'receipt, with comma.png' },
      { buffer: Buffer.from('nope'), filename: 'bad.txt' },
    ]);
    const batchId = (JSON.parse(response.body) as { id: string }).id;

    const csv = await harness.api.download(
      `/api/v1/batches/${batchId}/results.csv`,
      account.accessToken,
    );
    expect(csv.statusCode).toBe(200);
    expect(csv.headers.get('content-type')).toMatch(/text\/csv/);
    const text = csv.buffer().toString('utf8');
    expect(text).toContain('filename');
    // A comma inside a filename must be quoted, not split into a new column.
    expect(text).toContain('"receipt, with comma.png"');
    expect(text).toContain('bad.txt');
  });

  it('rejects an empty batch and is scoped to the organisation', async () => {
    const account = await registerAccount(harness);
    const empty = await postBatch(account.accessToken, []);
    expect(empty.statusCode).toBe(400);

    const created = await postBatch(account.accessToken, [
      { buffer: fakePng('scoped'), filename: 'scoped.png' },
    ]);
    const batchId = (JSON.parse(created.body) as { id: string }).id;

    const other = await registerAccount(harness);
    const peek = await harness.api.json('GET', `/api/v1/batches/${batchId}`, {
      token: other.accessToken,
    });
    expect(peek.statusCode).toBe(404);
  });

  it('rejects the 101st file before it can become another buffered batch item', async () => {
    const account = await registerAccount(harness);
    const form = new FormData();
    for (let index = 0; index <= MAX_BATCH_FILES; index += 1) {
      form.append(
        'files',
        new Blob([Buffer.from('x')], { type: 'application/octet-stream' }),
        `f-${index}.bin`,
      );
    }

    const response = await fetch(`${harness.baseUrl}/api/v1/batches`, {
      method: 'POST',
      headers: { authorization: `Bearer ${account.accessToken}` },
      body: form,
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: { code: 'FIELD_VALIDATION_FAILED', message: expect.stringContaining('100 files') },
    });

    const batches = await harness.api.json('GET', '/api/v1/batches', {
      token: account.accessToken,
    });
    expect(batches.json<{ items: unknown[] }>().items).toHaveLength(0);
  });

  it('destroys the 101st multipart stream before reading its bytes', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'idcp-batch-limit-test-'));
    let excessReadCalls = 0;
    const toBuffer = jest.fn(async () => Buffer.from('should not use toBuffer'));
    const excessStream = new Readable({
      read() {
        excessReadCalls += 1;
        this.push(Buffer.from('must not be read'));
        this.push(null);
      },
    });
    const filePart = (filename: string, file: Readable): MultipartFile => {
      const multipartFile = file as MultipartFile['file'];
      Object.assign(multipartFile, { truncated: false });
      return {
        type: 'file',
        file: multipartFile,
        filename,
        fieldname: 'files',
        encoding: '7bit',
        mimetype: 'application/octet-stream',
        fields: {},
        toBuffer,
      };
    };
    const parts = async function* () {
      for (let index = 0; index < MAX_BATCH_FILES; index += 1) {
        yield filePart(`file-${index}.bin`, Readable.from([Buffer.from('x')]));
      }
      yield filePart('excess.bin', excessStream);
    };

    try {
      await expect(spoolBatchParts(parts(), tempDir, 1024 * 1024, 1)).rejects.toThrow(
        `A batch can hold at most ${MAX_BATCH_FILES} files.`,
      );
      expect(excessStream.destroyed).toBe(true);
      expect(excessReadCalls).toBe(0);
      expect(toBuffer).not.toHaveBeenCalled();
      expect(await readdir(tempDir)).toHaveLength(MAX_BATCH_FILES);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('enforces the whole-request byte budget while spooling and cleans partial uploads', async () => {
    const boundedHarness = await createHarness({ MAX_REQUEST_MB: '1', MAX_UPLOAD_MB: '1' });
    const isolatedTemp = await mkdtemp(join(tmpdir(), 'idcp-budget-root-'));
    const previousTemp = process.env.TMPDIR;
    process.env.TMPDIR = isolatedTemp;
    try {
      const account = await registerAccount(boundedHarness);
      // Use an explicit, closable HTTP connection: a rejected upload may leave fetch's
      // streaming request body in flight, delaying server teardown on slower CI runners.
      const boundary = 'idcp-budget-test';
      const filePart = Buffer.concat([
        Buffer.from(
          `--${boundary}\r\nContent-Disposition: form-data; name="files"; filename="large.bin"\r\nContent-Type: application/octet-stream\r\n\r\n`,
        ),
        Buffer.alloc(400 * 1024),
        Buffer.from('\r\n'),
      ]);
      const payload = Buffer.concat([
        filePart,
        filePart,
        filePart,
        Buffer.from(`--${boundary}--\r\n`),
      ]);
      const response = await new Promise<{ status: number | undefined; body: string }>(
        (resolveResult, reject) => {
          const request = httpRequest(`${boundedHarness.baseUrl}/api/v1/batches`, {
            method: 'POST',
            headers: {
              authorization: `Bearer ${account.accessToken}`,
              'content-type': `multipart/form-data; boundary=${boundary}`,
              'content-length': payload.length,
              connection: 'close',
            },
          });
          const timeout = setTimeout(
            () => request.destroy(new Error('batch rejection timed out')),
            10_000,
          );
          request.once('error', (error) => {
            clearTimeout(timeout);
            reject(error);
          });
          request.once('response', (message) => {
            const chunks: Buffer[] = [];
            message.on('data', (chunk: Buffer) => chunks.push(chunk));
            message.on('end', () => {
              clearTimeout(timeout);
              resolveResult({
                status: message.statusCode,
                body: Buffer.concat(chunks).toString('utf8'),
              });
              request.destroy();
            });
          });
          request.end(payload);
        },
      );
      expect(response.status).toBe(413);
      expect(JSON.parse(response.body)).toMatchObject({
        error: {
          code: 'PAYLOAD_TOO_LARGE',
          message: 'The batch exceeds the 1 MB request limit.',
        },
      });
      expect(await readdir(isolatedTemp)).toEqual([]);

      const batches = await boundedHarness.api.json('GET', '/api/v1/batches', {
        token: account.accessToken,
      });
      expect(batches.json<{ items: unknown[] }>().items).toHaveLength(0);
    } finally {
      try {
        await boundedHarness.close();
      } finally {
        if (previousTemp === undefined) delete process.env.TMPDIR;
        else process.env.TMPDIR = previousTemp;
        await rm(isolatedTemp, { recursive: true, force: true });
      }
    }
  });

  it('rejects an over-budget batch before a slow client finishes sending', async () => {
    const boundedHarness = await createHarness({ MAX_REQUEST_MB: '1', MAX_UPLOAD_MB: '1' });
    try {
      const account = await registerAccount(boundedHarness);
      const boundary = 'idcp-slow-batch';
      const url = new URL(`${boundedHarness.baseUrl}/api/v1/batches`);
      const result = await new Promise<{ status: number | undefined; body: string }>(
        (resolveResult, reject) => {
          const request = httpRequest(url, {
            method: 'POST',
            headers: {
              authorization: `Bearer ${account.accessToken}`,
              'content-type': `multipart/form-data; boundary=${boundary}`,
            },
          });
          const timeout = setTimeout(
            () => request.destroy(new Error('server did not reject the unfinished request')),
            5000,
          );
          request.once('error', (error) => {
            clearTimeout(timeout);
            reject(error);
          });
          request.once('response', (response) => {
            const chunks: Buffer[] = [];
            response.on('data', (chunk: Buffer) => chunks.push(chunk));
            response.on('end', () => {
              clearTimeout(timeout);
              resolveResult({
                status: response.statusCode,
                body: Buffer.concat(chunks).toString('utf8'),
              });
              request.destroy();
            });
          });
          const header = `--${boundary}\r\nContent-Disposition: form-data; name="files"; filename="part.bin"\r\nContent-Type: application/octet-stream\r\n\r\n`;
          for (let i = 0; i < 3; i += 1) {
            request.write(header);
            request.write(Buffer.alloc(400 * 1024));
            if (i < 2) request.write('\r\n');
          }
          // Intentionally omit the final boundary and request.end(): the server must reject on size.
        },
      );
      expect(result.status).toBe(413);
      expect(JSON.parse(result.body)).toMatchObject({ error: { code: 'PAYLOAD_TOO_LARGE' } });
    } finally {
      await boundedHarness.close();
    }
  }, 12_000);

  it('assigns a batch to a project and can read it back', async () => {
    const account = await registerAccount(harness);
    const project = await harness.api.json('POST', '/api/v1/projects', {
      token: account.accessToken,
      body: { name: 'October audit' },
    });
    const projectId = project.json<{ id: string }>().id;

    const response = await postBatch(
      account.accessToken,
      [{ buffer: fakePng('proj'), filename: 'proj.png' }],
      { projectId, name: 'Audit intake' },
    );
    expect(response.statusCode).toBe(201);
    const batch = JSON.parse(response.body) as { projectId: string };
    expect(batch.projectId).toBe(projectId);
  });
});
