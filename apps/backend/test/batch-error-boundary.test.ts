import { AppError } from '@idcp/shared';
import { createLogger } from '../src/logger';
import { createHarness, fakePng, registerAccount } from './helpers';

it('masks adapter exceptions on batch creation, reads and CSV, including legacy rows', async () => {
  const logs: string[] = [];
  const harness = await createHarness(
    {},
    { logger: createLogger({ level: 'debug', sink: (line) => logs.push(line) }) },
  );
  try {
    const account = await registerAccount(harness);
    const foreign = await registerAccount(harness, { email: 'foreign-batch-boundary@example.com' });
    const secret = 'SYNTHETIC-CREDENTIAL-AND-DOCUMENT-CONTENT';
    const original = harness.storage.put.bind(harness.storage);
    const put = jest
      .spyOn(harness.storage, 'put')
      .mockRejectedValueOnce(new Error(secret))
      .mockRejectedValueOnce(new AppError('UNSUPPORTED_MEDIA_TYPE', secret))
      .mockRejectedValueOnce({ reason: secret })
      .mockImplementation(original);
    const form = new FormData();
    for (const index of [0, 1, 2, 3])
      form.append(
        'files',
        new Blob([new Uint8Array(fakePng(`test-${index}`))]),
        `file-${index}.png`,
      );
    const response = await fetch(`${harness.baseUrl}/api/v1/batches`, {
      method: 'POST',
      headers: { authorization: `Bearer ${account.accessToken}` },
      body: form,
    });
    expect(response.status).toBe(201);
    const created = await response.text();
    expect(created).not.toContain(secret);
    const batch = JSON.parse(created) as {
      id: string;
      items: Array<{ status: string; error?: string; documentId: string | null }>;
    };
    expect(batch.items.map((item) => item.status)).toEqual([
      'failed',
      'failed',
      'failed',
      'queued',
    ]);
    expect(batch.items[1]?.error).toMatch(/not supported/i);
    expect(batch.items[3]?.documentId).not.toBeNull();
    const stored = await harness.db.query<{ error: string | null }>(
      'SELECT error FROM batch_items WHERE batch_id = ? ORDER BY position',
      [batch.id],
    );
    expect(JSON.stringify(stored)).not.toContain(secret);
    // Pre-existing arbitrary database text remains in storage, but is not served to clients.
    await harness.db.execute(
      'UPDATE batch_items SET error = ? WHERE batch_id = ? AND position = 0',
      [secret, batch.id],
    );
    const detail = await harness.api.get(`/api/v1/batches/${batch.id}`, account.accessToken);
    const list = await harness.api.get('/api/v1/batches', account.accessToken);
    const items = await harness.api.get(`/api/v1/batches/${batch.id}/items`, account.accessToken);
    const csv = await harness.api.get(
      `/api/v1/batches/${batch.id}/results.csv`,
      account.accessToken,
    );
    for (const result of [detail, list, items, csv]) {
      expect(result.statusCode).toBe(200);
      expect(result.body).not.toContain(secret);
    }
    expect(detail.body).toContain('This file could not be processed');
    expect(
      (await harness.api.get(`/api/v1/batches/${batch.id}`, foreign.accessToken)).statusCode,
    ).toBe(404);
    expect(logs.join('\n')).not.toContain(secret);
    expect(
      (
        await harness.db.one<{ error: string }>(
          'SELECT error FROM batch_items WHERE batch_id = ? AND position = 0',
          [batch.id],
        )
      )?.error,
    ).toBe(secret);
    put.mockRestore();
  } finally {
    await harness.close();
  }
});
