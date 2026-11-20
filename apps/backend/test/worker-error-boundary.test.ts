import { createLogger } from '../src/logger';
import { ProviderUnavailableError } from '../src/ai/providers/types';
import { createHarness, drainWorker, fakePng, registerAccount, uploadDocument } from './helpers';

it.each([
  ['ordinary error', new Error('sensitive document text and credential: SECRET-EXAMPLE')],
  [
    'provider error',
    new ProviderUnavailableError('sensitive document text and credential: SECRET-EXAMPLE'),
  ],
])(
  'does not publish or persist arbitrary OCR failure details from an %s',
  async (_label, error) => {
    const logs: string[] = [];
    const harness = await createHarness(
      {},
      {
        logger: createLogger({ level: 'debug', sink: (line) => logs.push(line) }),
      },
    );
    try {
      const account = await registerAccount(harness);
      const events: Array<{ event: string; payload: Record<string, unknown> }> = [];
      const unsubscribe = harness.hub.subscribe(
        { organisationId: account.organisationId },
        (event, payload) => {
          events.push({ event, payload });
        },
      );
      try {
        harness.ocr.failWith(error);
        const upload = await uploadDocument(harness, account, { content: fakePng('failure') });
        const documentId = upload.json<{ id: string }>().id;
        for (let attempt = 0; attempt < 6; attempt += 1) {
          await harness.db.execute("UPDATE jobs SET run_after = ? WHERE status = 'queued'", [
            new Date(Date.now() - 1000).toISOString(),
          ]);
          await drainWorker(harness);
        }
        const job = await harness.db.one<{ status: string; last_error: string }>(
          'SELECT status, last_error FROM jobs WHERE document_id = ?',
          [documentId],
        );
        expect(job).toEqual({
          status: 'dead',
          last_error: 'Document extraction failed. Investigate the worker and retry.',
        });
        const failure = events.find((entry) => entry.event === 'document:failed');
        expect(failure?.payload).toEqual({
          documentId,
          code: 'EXTRACTION_FAILED',
          message: job?.last_error,
        });
        expect(JSON.stringify({ job, events, logs })).not.toContain('SECRET-EXAMPLE');
      } finally {
        unsubscribe();
      }
    } finally {
      await harness.close();
    }
  },
);
