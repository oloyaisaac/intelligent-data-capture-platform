import { DocumentsRepository } from '../src/repositories/document-repo';
import { JobsRepository } from '../src/repositories/system-repo';
import { WorkerRecoveryRepository } from '../src/repositories/worker-recovery-repo';
import { buildServices } from '../src/services/container';
import type { OcrProvider } from '../src/ai/providers/types';
import { createHarness, registerAccount, type Harness } from './helpers';

function remoteWorker(harness: Harness, ocr: OcrProvider['ocr']) {
  const provider: OcrProvider = { name: 'synthetic-remote', isLocal: false, ocr };
  return buildServices({
    config: harness.config,
    db: harness.db,
    storage: harness.storage,
    hub: harness.hub,
    provider,
  }).worker;
}

async function count(harness: Harness, id: string): Promise<number | undefined> {
  return (
    await harness.db.one<{ remote_ocr_invocations: number }>(
      'SELECT remote_ocr_invocations FROM documents WHERE id = ?',
      [id],
    )
  )?.remote_ocr_invocations;
}

it('limits remote calls across completed reprocess jobs, but not unrelated documents', async () => {
  const harness = await createHarness({ AI_MAX_REMOTE_CALLS_PER_DOC: '2' });
  try {
    const account = await registerAccount(harness);
    const upload = await harness.api.upload(account.accessToken);
    const id = upload.json<{ id: string }>().id;
    const ocr = jest.fn(() => harness.ocr.ocr());
    const worker = remoteWorker(harness, ocr);
    expect(await worker.drain()).toBe(1);
    expect(await count(harness, id)).toBe(1);
    expect(
      (
        await harness.api.json('POST', `/api/v1/documents/${id}/reprocess`, {
          token: account.accessToken,
        })
      ).statusCode,
    ).toBe(202);
    expect(await worker.drain()).toBe(1);
    expect(await count(harness, id)).toBe(2);
    expect(
      (
        await harness.api.json('POST', `/api/v1/documents/${id}/reprocess`, {
          token: account.accessToken,
        })
      ).statusCode,
    ).toBe(202);
    expect(await worker.drain()).toBe(1);
    expect(ocr).toHaveBeenCalledTimes(2);
    expect(await count(harness, id)).toBe(2);
    const second = await harness.api.upload(account.accessToken, {
      content: Buffer.from('89504e470d0a1a0a0000000d4948445202', 'hex'),
    });
    const secondId = second.json<{ id: string }>().id;
    expect(await worker.drain()).toBe(1);
    expect(await count(harness, secondId)).toBe(1);
    expect(ocr).toHaveBeenCalledTimes(3);
  } finally {
    await harness.close();
  }
});

it('consumes a reservation on provider failure and disables all further remote calls at the limit', async () => {
  const harness = await createHarness({ AI_MAX_REMOTE_CALLS_PER_DOC: '1' });
  try {
    const account = await registerAccount(harness);
    const id = (await harness.api.upload(account.accessToken)).json<{ id: string }>().id;
    const ocr = jest.fn().mockRejectedValue(new Error('synthetic timeout'));
    const worker = remoteWorker(harness, ocr);
    await worker.drain();
    expect(await count(harness, id)).toBe(1);
    expect(ocr).toHaveBeenCalledTimes(1);
    for (let attempt = 0; attempt < 5; attempt++) {
      await harness.db.execute("UPDATE jobs SET run_after = ? WHERE status = 'queued'", [
        new Date(0).toISOString(),
      ]);
      await worker.drain();
    }
    const job = (await new JobsRepository(harness.db).listForDocument(id))[0]!;
    expect(job.status).toBe('dead');
    expect(
      (await harness.db.one<{ status: string }>('SELECT status FROM documents WHERE id = ?', [id]))
        ?.status,
    ).toBe('failed');
    expect(await count(harness, id)).toBe(1);
    expect(ocr).toHaveBeenCalledTimes(1);
  } finally {
    await harness.close();
  }
});

it('honors zero as a remote-call kill switch without preventing local OCR', async () => {
  const harness = await createHarness({ AI_MAX_REMOTE_CALLS_PER_DOC: '0' });
  try {
    const account = await registerAccount(harness);
    const id = (await harness.api.upload(account.accessToken)).json<{ id: string }>().id;
    const ocr = jest.fn(() => harness.ocr.ocr());
    await remoteWorker(harness, ocr).drain();
    expect(ocr).not.toHaveBeenCalled();
    expect(await count(harness, id)).toBe(0);
    await harness.db.execute("UPDATE jobs SET run_after = ? WHERE status = 'queued'", [
      new Date(0).toISOString(),
    ]);
    await harness.services.worker.drain();
    expect(harness.ocr.calls).toBe(1);
    expect(await count(harness, id)).toBe(0);
  } finally {
    await harness.close();
  }
});

it('does not reserve or invoke when the claim was abandoned while loading the image', async () => {
  const harness = await createHarness({ AI_MAX_REMOTE_CALLS_PER_DOC: '1' });
  let unblock!: () => void;
  const gate = new Promise<void>((resolve) => {
    unblock = resolve;
  });
  let entered!: () => void;
  const waiting = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let draining: Promise<number> | undefined;
  try {
    const account = await registerAccount(harness);
    const id = (await harness.api.upload(account.accessToken)).json<{ id: string }>().id;
    const original = harness.storage.get.bind(harness.storage);
    jest.spyOn(harness.storage, 'get').mockImplementation(async (key) => {
      entered();
      await gate;
      return original(key);
    });
    const ocr = jest.fn(() => harness.ocr.ocr());
    draining = remoteWorker(harness, ocr).drain();
    await waiting;
    const job = (await new JobsRepository(harness.db).listForDocument(id))[0]!;
    expect(
      await new WorkerRecoveryRepository(harness.db).abandonWithAudit({
        id: job.id,
        attempt: 1,
        operatorReference: 'operator',
        incidentReference: 'INC-42',
      }),
    ).toEqual({ abandoned: true, documentFailed: true });
    unblock();
    await draining;
    expect(ocr).not.toHaveBeenCalled();
    expect(await count(harness, id)).toBe(0);
  } finally {
    unblock();
    await draining?.catch(() => undefined);
    await harness.close();
  }
});

it('serializes competing reservations and checks tenant, document state and limit', async () => {
  const harness = await createHarness();
  try {
    const account = await registerAccount(harness);
    const other = await registerAccount(harness, { email: 'other-remote-limit@example.com' });
    const id = (await harness.api.upload(account.accessToken)).json<{ id: string }>().id;
    await harness.db.execute("UPDATE documents SET status = 'processing' WHERE id = ?", [id]);
    const reserve = (org: string, max: number) =>
      harness.db.transaction((tx) =>
        new DocumentsRepository(tx).reserveRemoteOcrInvocation(org, id, max),
      );
    expect(await reserve(other.organisationId, 2)).toBe(false);
    expect(await reserve(account.organisationId, 0)).toBe(false);
    const result = await Promise.all([
      reserve(account.organisationId, 1),
      reserve(account.organisationId, 1),
    ]);
    expect(result.filter(Boolean)).toHaveLength(1);
    expect(await count(harness, id)).toBe(1);
    await harness.db.execute(
      "UPDATE documents SET status = 'deleted', deleted_at = ? WHERE id = ?",
      [new Date().toISOString(), id],
    );
    expect(await reserve(account.organisationId, 10)).toBe(false);
  } finally {
    await harness.close();
  }
});

it('rolls back a reservation failure and never calls the provider', async () => {
  const harness = await createHarness({ AI_MAX_REMOTE_CALLS_PER_DOC: '1' });
  try {
    const account = await registerAccount(harness);
    const id = (await harness.api.upload(account.accessToken)).json<{ id: string }>().id;
    const original = DocumentsRepository.prototype.reserveRemoteOcrInvocation;
    const spy = jest
      .spyOn(DocumentsRepository.prototype, 'reserveRemoteOcrInvocation')
      .mockImplementationOnce(async function (this: DocumentsRepository, ...args) {
        expect(await original.apply(this, args)).toBe(true);
        throw new Error('synthetic reservation transaction failure');
      });
    const ocr = jest.fn(() => harness.ocr.ocr());
    try {
      await remoteWorker(harness, ocr).drain();
    } finally {
      spy.mockRestore();
    }
    expect(ocr).not.toHaveBeenCalled();
    expect(await count(harness, id)).toBe(0);
  } finally {
    await harness.close();
  }
});

it('keeps an ambiguously committed reservation and does not call the provider after lost acknowledgement', async () => {
  const harness = await createHarness({ AI_MAX_REMOTE_CALLS_PER_DOC: '1' });
  try {
    const account = await registerAccount(harness);
    const id = (await harness.api.upload(account.accessToken)).json<{ id: string }>().id;
    const originalReserve = DocumentsRepository.prototype.reserveRemoteOcrInvocation;
    const originalTransaction = harness.db.transaction.bind(harness.db);
    let committedReservation = false;
    const reserve = jest
      .spyOn(DocumentsRepository.prototype, 'reserveRemoteOcrInvocation')
      .mockImplementationOnce(async function (this: DocumentsRepository, ...args) {
        const result = await originalReserve.apply(this, args);
        committedReservation = result;
        return result;
      });
    const transaction = jest.spyOn(harness.db, 'transaction').mockImplementation(async (run) => {
      const result = await originalTransaction(run);
      if (committedReservation) {
        committedReservation = false;
        throw new Error('synthetic lost commit acknowledgement');
      }
      return result;
    });
    const ocr = jest.fn(() => harness.ocr.ocr());
    const worker = remoteWorker(harness, ocr);
    try {
      await worker.drain();
      expect(await count(harness, id)).toBe(1);
      expect(
        await harness.db.one(
          'SELECT invocations FROM remote_ocr_organisation_counts WHERE organisation_id = ?',
          [account.organisationId],
        ),
      ).toEqual({ invocations: 1 });
      expect(ocr).not.toHaveBeenCalled();
      await harness.db.execute("UPDATE jobs SET run_after = ? WHERE status = 'queued'", [
        new Date(0).toISOString(),
      ]);
      await worker.drain();
      expect(ocr).not.toHaveBeenCalled();
      expect(await count(harness, id)).toBe(1);
      expect(
        await harness.db.one(
          'SELECT invocations FROM remote_ocr_organisation_counts WHERE organisation_id = ?',
          [account.organisationId],
        ),
      ).toEqual({ invocations: 1 });
    } finally {
      reserve.mockRestore();
      transaction.mockRestore();
    }
  } finally {
    await harness.close();
  }
});
