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
