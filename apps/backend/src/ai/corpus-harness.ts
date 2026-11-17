import type { DocumentType } from '@idcp/shared';
import type { Config } from '../config';
import type { Database } from '../db/database';
import type { Logger } from '../logger';
import { runExtractionPipeline } from './pipeline';
import type { OcrInput, OcrProvider, OcrResult } from './providers/types';

/**
 * Corpus & UAT Measurement Harness (MC-08 / AI-002).
 *
 * Evaluates the real `runExtractionPipeline` (classification, field extraction, UDM schema
 * validation, and review-threshold routing) against a labelled document set and reports
 * per-document latency, field accuracy, and no-correction rate.
 */

export type ExpectedFieldValue = string | number | boolean | null;

export interface CorpusDocument {
  id: string;
  content: string;
  operatorId: string;
  mimeType?: string;
  expectedDocumentType?: DocumentType;
  expectedFields?: Record<string, ExpectedFieldValue>;
}

export interface MeasurementResult {
  documentsProcessed: number;
  timeOnTaskSeconds: number;
  noCorrectionRate: number;
  accuracyScore: number;
  operatorCount: number;
}

class CorpusTextOcrProvider implements OcrProvider {
  readonly name = 'corpus-text-ocr';
  readonly isLocal = true;

  async ocr(input: OcrInput): Promise<OcrResult> {
    const text = input.buffer.toString('utf8');
    return {
      text,
      words: text
        .split(/\s+/)
        .filter(Boolean)
        .map((word) => ({ text: word, confidence: 0.96 })),
      provider: this.name,
      latencyMs: 1,
      costMicros: 0,
    };
  }
}

export async function executeCorpusHarness(
  _db: Database,
  config: Config,
  logger: Logger,
  corpus: CorpusDocument[],
  options: { provider?: OcrProvider } = {},
): Promise<MeasurementResult> {
  if (corpus.length === 0) {
    throw new Error('Corpus must contain at least one labelled document.');
  }

  const provider = options.provider ?? new CorpusTextOcrProvider();
  const operators = new Set(corpus.map((doc) => doc.operatorId));
  const startTime = Date.now();

  let zeroCorrectionDocs = 0;
  let totalChecks = 0;
  let passedChecks = 0;

  for (const doc of corpus) {
    const startDoc = Date.now();
    const result = await runExtractionPipeline(
      {
        documentId: doc.id,
        buffer: Buffer.from(doc.content, 'utf8'),
        mimeType: doc.mimeType ?? 'image/png',
        reviewThreshold: config.AI_REVIEW_CONFIDENCE_THRESHOLD,
      },
      { provider, logger },
    );
    const elapsedSeconds = (Date.now() - startDoc) / 1000;

    let docAccurate = true;

    if (doc.expectedDocumentType !== undefined) {
      totalChecks += 1;
      if (result.udm.documentType === doc.expectedDocumentType) {
        passedChecks += 1;
      } else {
        docAccurate = false;
      }
    }

    if (doc.expectedFields) {
      for (const [path, expectedValue] of Object.entries(doc.expectedFields)) {
        totalChecks += 1;
        const actualValue = result.udm.fields[path]?.value ?? null;
        if (actualValue === expectedValue) {
          passedChecks += 1;
        } else {
          docAccurate = false;
        }
      }
    }

    if (docAccurate) {
      zeroCorrectionDocs += 1;
    }

    logger.debug('corpus document evaluated', {
      documentId: doc.id,
      accurate: docAccurate,
      elapsedSeconds: Number(elapsedSeconds.toFixed(4)),
    });
  }

  const totalTime = Math.max((Date.now() - startTime) / 1000, 0.001);
  const noCorrectionRate = (zeroCorrectionDocs / corpus.length) * 100;
  const accuracyScore = totalChecks > 0 ? (passedChecks / totalChecks) * 100 : noCorrectionRate;

  logger.info('corpus measurement complete', {
    documentsProcessed: corpus.length,
    operatorCount: operators.size,
    noCorrectionRate: Number(noCorrectionRate.toFixed(2)),
    accuracyScore: Number(accuracyScore.toFixed(2)),
    secondsPerDocument: Number((totalTime / corpus.length).toFixed(4)),
  });

  return {
    documentsProcessed: corpus.length,
    timeOnTaskSeconds: totalTime,
    noCorrectionRate,
    accuracyScore,
    operatorCount: operators.size,
  };
}

export async function executeUatPilot(
  db: Database,
  config: Config,
  logger: Logger,
  pilotParticipants: string[],
  documentSets: CorpusDocument[][],
): Promise<MeasurementResult[]> {
  if (pilotParticipants.length === 0 || pilotParticipants.length !== documentSets.length) {
    throw new Error('Pilot participants and document sets must be non-empty and aligned.');
  }

  const results: MeasurementResult[] = [];
  for (let index = 0; index < pilotParticipants.length; index += 1) {
    const docs = documentSets[index]!;
    const result = await executeCorpusHarness(db, config, logger, docs);
    results.push(result);
  }
  return results;
}
