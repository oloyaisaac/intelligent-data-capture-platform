import { RemoteOcrBudgetRepository } from '../src/repositories/remote-ocr-budget-repo';
import { DocumentsRepository } from '../src/repositories/document-repo';
import { createLogger } from '../src/logger';
import { buildServices } from '../src/services/container';
import type { OcrProvider } from '../src/ai/providers/types';
import { createHarness, fakePng, registerAccount, type Harness } from './helpers';

function remoteWorker(harness: Harness, ocr: OcrProvider['ocr']) {
  return buildServices({
    config: harness.config,
    db: harness.db,
    storage: harness.storage,
    hub: harness.hub,
    logger: harness.services.logger,
    provider: { name: 'remote-test', isLocal: false, ocr },
  }).worker;
}
async function count(harness: Harness, organisationId: string): Promise<number> {
  return (
    (
      await harness.db.one<{ invocations: number }>(
        'SELECT invocations FROM remote_ocr_organisation_counts WHERE organisation_id = ?',
        [organisationId],
      )
    )?.invocations ?? 0
  );
}

it('enforces the lifetime organisation limit across documents without blocking another organisation', async () => {
  const harness = await createHarness({ AI_MAX_REMOTE_CALLS_PER_ORG: '2' });
  try {
    const account = await registerAccount(harness);
    const other = await registerAccount(harness, { email: 'other-budget@example.com' });
    const ids: string[] = [];
    for (const index of [0, 1, 2])
      ids.push(
        (
          await harness.api.upload(account.accessToken, { content: fakePng(`budget-${index}`) })
        ).json<{ id: string }>().id,
      );
    const otherId = (
      await harness.api.upload(other.accessToken, { content: fakePng('other-budget') })
    ).json<{ id: string }>().id;
    const ocr = jest.fn(() => harness.ocr.ocr());
    await remoteWorker(harness, ocr).drain();
    expect(ocr).toHaveBeenCalledTimes(3);
    expect(await count(harness, account.organisationId)).toBe(2);
    expect(await count(harness, other.organisationId)).toBe(1);
    const rows = await harness.db.query<{ remote_ocr_invocations: number }>(
      'SELECT remote_ocr_invocations FROM documents WHERE organisation_id = ?',
      [account.organisationId],
    );
    expect(rows.map((row) => row.remote_ocr_invocations).sort()).toEqual([0, 1, 1]);
    expect(
      (
        await harness.db.one<{ remote_ocr_invocations: number }>(
          'SELECT remote_ocr_invocations FROM documents WHERE id = ?',
          [otherId],
        )
      )?.remote_ocr_invocations,
    ).toBe(1);
    // Deleting a document cannot restore an organisation reservation.
    await harness.db.execute('DELETE FROM documents WHERE id = ?', [ids[0]]);
    expect(await count(harness, account.organisationId)).toBe(2);
  } finally {
    await harness.close();
  }
});

it('rolls back the organisation counter when the document cap rejects the reservation', async () => {
  const harness = await createHarness({
    AI_MAX_REMOTE_CALLS_PER_ORG: '2',
    AI_MAX_REMOTE_CALLS_PER_DOC: '0',
  });
  try {
    const account = await registerAccount(harness);
    const id = (await harness.api.upload(account.accessToken)).json<{ id: string }>().id;
    const ocr = jest.fn(() => harness.ocr.ocr());
    await remoteWorker(harness, ocr).drain();
    expect(ocr).not.toHaveBeenCalled();
    expect(await count(harness, account.organisationId)).toBe(0);
    expect(
      (
        await harness.db.one<{ remote_ocr_invocations: number }>(
          'SELECT remote_ocr_invocations FROM documents WHERE id = ?',
          [id],
        )
      )?.remote_ocr_invocations,
    ).toBe(0);
  } finally {
    await harness.close();
  }
});

it('zero organisation limit blocks remote OCR but not local OCR', async () => {
  const harness = await createHarness({ AI_MAX_REMOTE_CALLS_PER_ORG: '0' });
  try {
    const account = await registerAccount(harness);
    await harness.api.upload(account.accessToken);
    const ocr = jest.fn(() => harness.ocr.ocr());
    await remoteWorker(harness, ocr).drain();
    expect(ocr).not.toHaveBeenCalled();
    expect(await count(harness, account.organisationId)).toBe(0);
    await harness.db.execute("UPDATE jobs SET run_after = ? WHERE status = 'queued'", [
      new Date(0).toISOString(),
    ]);
    await harness.services.worker.drain();
    expect(harness.ocr.calls).toBe(1);
  } finally {
    await harness.close();
  }
});

it('serializes reservations at the organisation cap and fails closed for invalid caps', async () => {
  const harness = await createHarness();
  try {
    const account = await registerAccount(harness);
    const reserve = (max: number) =>
      harness.db.transaction((tx) =>
        new RemoteOcrBudgetRepository(tx).reserve(account.organisationId, max),
      );
    expect(await reserve(0)).toBe(false);
    for (const invalid of [-1, 1.5, Number.NaN, 10_000_001])
      await expect(reserve(invalid)).rejects.toThrow();
    const results = await Promise.all(Array.from({ length: 8 }, () => reserve(3)));
    expect(results.filter(Boolean)).toHaveLength(3);
    expect(await count(harness, account.organisationId)).toBe(3);
    expect(await reserve(2)).toBe(false);
    expect(await count(harness, account.organisationId)).toBe(3);
  } finally {
    await harness.close();
  }
});

it('rolls both counters back on document reservation failure', async () => {
  const harness = await createHarness({ AI_MAX_REMOTE_CALLS_PER_ORG: '1' });
  try {
    const account = await registerAccount(harness);
    const id = (await harness.api.upload(account.accessToken)).json<{ id: string }>().id;
    const original = DocumentsRepository.prototype.reserveRemoteOcrInvocation;
    const spy = jest
      .spyOn(DocumentsRepository.prototype, 'reserveRemoteOcrInvocation')
      .mockImplementationOnce(async function (this: DocumentsRepository, ...args) {
        expect(await original.apply(this, args)).toBe(true);
        throw new Error('simulated failure before commit');
      });
    const ocr = jest.fn();
    try {
      await remoteWorker(harness, ocr).drain();
    } finally {
      spy.mockRestore();
    }
    expect(ocr).not.toHaveBeenCalled();
    expect(await count(harness, account.organisationId)).toBe(0);
    expect(
      (
        await harness.db.one<{ remote_ocr_invocations: number }>(
          'SELECT remote_ocr_invocations FROM documents WHERE id = ?',
          [id],
        )
      )?.remote_ocr_invocations,
    ).toBe(0);
  } finally {
    await harness.close();
  }
});

it('publishes a fixed organisation-limit reason after retries without calling the provider', async () => {
  const logs: string[] = [];
  const harness = await createHarness(
    { AI_MAX_REMOTE_CALLS_PER_ORG: '0' },
    { logger: createLogger({ level: 'debug', sink: (line) => logs.push(line) }) },
  );
  try {
    const account = await registerAccount(harness);
    const events: Array<{ event: string; payload: Record<string, unknown> }> = [];
    const unsubscribe = harness.hub.subscribe(
      { organisationId: account.organisationId },
      (event, payload) => events.push({ event, payload }),
    );
    try {
      const id = (await harness.api.upload(account.accessToken)).json<{ id: string }>().id;
      const ocr = jest.fn();
      const worker = remoteWorker(harness, ocr);
      for (let attempt = 0; attempt < 6; attempt++) {
        await harness.db.execute("UPDATE jobs SET run_after = ? WHERE status = 'queued'", [
          new Date(0).toISOString(),
        ]);
        await worker.drain();
      }
      const message = 'Remote OCR organisation invocation limit reached. Contact an administrator.';
      expect(
        await harness.db.one('SELECT status, last_error FROM jobs WHERE document_id = ?', [id]),
      ).toEqual({ status: 'dead', last_error: message });
      expect(events.find((event) => event.event === 'document:failed')?.payload).toEqual({
        documentId: id,
        code: 'EXTRACTION_FAILED',
        message,
      });
      expect(logs.join('\n')).toContain(message);
      expect(ocr).not.toHaveBeenCalled();
    } finally {
      unsubscribe();
    }
  } finally {
    await harness.close();
  }
});
