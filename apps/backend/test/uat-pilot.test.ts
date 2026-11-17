import {
  executeCorpusHarness,
  executeUatPilot,
  type CorpusDocument,
} from '../src/ai/corpus-harness';
import type { Config } from '../src/config';
import type { Database } from '../src/db/database';
import { createLogger, type Logger } from '../src/logger';
import { SAMPLE_ID_TEXT, SAMPLE_INVOICE_TEXT, SAMPLE_RECEIPT_TEXT, testConfig } from './helpers';

describe('UAT Pilot & Corpus Evaluation Harness (MC-08)', () => {
  let db: Database;
  let config: Config;
  let logger: Logger;

  beforeAll(() => {
    db = {} as Database;
    config = testConfig();
    logger = createLogger({ level: 'error', sink: () => undefined });
  });

  function buildSampleDocument(id: string, operatorId: string, index: number): CorpusDocument {
    const mod = index % 3;
    if (mod === 0) {
      return {
        id,
        operatorId,
        content: SAMPLE_INVOICE_TEXT,
        expectedDocumentType: 'invoice',
        expectedFields: {
          'invoice.number': 'INV-1042',
          'document.date': '2026-10-26',
          'total.amount': 1121000,
        },
      };
    }
    if (mod === 1) {
      return {
        id,
        operatorId,
        content: SAMPLE_RECEIPT_TEXT,
        expectedDocumentType: 'receipt',
        expectedFields: {
          'receipt.number': 'RCT-88',
          'document.date': '2026-10-24',
        },
      };
    }
    return {
      id,
      operatorId,
      content: SAMPLE_ID_TEXT,
      expectedDocumentType: 'id',
      expectedFields: {
        'id.number': 'UG-123456789',
        'person.surname': 'NAMONO',
      },
    };
  }

  it('evaluates real extraction accuracy and latency across a 100-document labelled corpus', async () => {
    const corpus = Array.from({ length: 100 }, (_, i) =>
      buildSampleDocument(`doc-${i}`, `operator-${i % 5}`, i),
    );

    const result = await executeCorpusHarness(db, config, logger, corpus);

    expect(result.documentsProcessed).toBe(100);
    expect(result.operatorCount).toBe(5);
    expect(result.timeOnTaskSeconds).toBeGreaterThan(0);
    expect(result.noCorrectionRate).toBe(100);
    expect(result.accuracyScore).toBe(100);
  });

  it('aggregates UAT pilot runs across 5 operators × 20 documents', async () => {
    const pilotParticipants = ['op-1', 'op-2', 'op-3', 'op-4', 'op-5'];
    const documentSets = pilotParticipants.map((op, opIdx) =>
      Array.from({ length: 20 }, (_, docIdx) =>
        buildSampleDocument(`doc-${op}-${docIdx}`, op, opIdx * 20 + docIdx),
      ),
    );

    const results = await executeUatPilot(db, config, logger, pilotParticipants, documentSets);

    expect(results).toHaveLength(5);
    for (const run of results) {
      expect(run.documentsProcessed).toBe(20);
      expect(run.operatorCount).toBe(1);
      expect(run.timeOnTaskSeconds).toBeGreaterThan(0);
      expect(run.accuracyScore).toBe(100);
    }

    const totalDocs = results.reduce((sum, run) => sum + run.documentsProcessed, 0);
    expect(totalDocs).toBe(100);
  });

  it('rejects an empty corpus rather than reporting vacuous metrics', async () => {
    await expect(executeCorpusHarness(db, config, logger, [])).rejects.toThrow(
      /at least one labelled document/i,
    );
  });
});
