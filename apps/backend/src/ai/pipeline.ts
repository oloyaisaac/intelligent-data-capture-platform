import {
  LIMITS,
  UDM_VERSION,
  lowConfidenceFields,
  parseUdm,
  requiresReview,
  type DocumentType,
  type Udm,
} from '@idcp/shared';
import type { Logger } from '../logger';
import { classifyDocument } from './classify';
import { extractFromText } from './extract';
import { CloudVisionProvider } from './providers/cloud';
import { TesseractProvider } from './providers/tesseract';
import type { OcrProvider, OcrWord } from './providers/types';

export interface PipelineInput {
  documentId: string;
  buffer: Buffer;
  mimeType: string;
  documentTypeHint?: DocumentType;
  defaultCurrency?: string;
  reviewThreshold?: number;
  expectedFields?: Array<{
    path: string;
    label: string;
    type: string;
    required?: boolean;
  }> | null;
}

export interface PipelineResult {
  udm: Udm;
  provider: string;
  latencyMs: number;
  costMicros: number;
  ocrText: string;
  words: OcrWord[];
}

export async function runExtractionPipeline(
  input: PipelineInput,
  deps: { provider: OcrProvider; logger: Logger },
): Promise<PipelineResult> {
  const threshold = input.reviewThreshold ?? LIMITS.reviewConfidenceThreshold;

  const ocr = await deps.provider.ocr(
    { buffer: input.buffer, mimeType: input.mimeType },
    { logger: deps.logger },
  );

  const classification =
    input.documentTypeHint && input.documentTypeHint !== 'unknown'
      ? { documentType: input.documentTypeHint, confidence: 1 }
      : classifyDocument(ocr.text);

  const extraction = extractFromText(ocr.text, classification.documentType as DocumentType, {
    defaultCurrency: input.defaultCurrency,
    expectedFields: input.expectedFields ?? null,
  });

  const matchedWordConfidences =
    ocr.words.length > 0
      ? ocr.words.reduce((sum, word) => sum + word.confidence, 0) / ocr.words.length
      : null;

  // If OCR itself was low quality, no field can honestly claim high confidence.
  const ocrQualityFactor = matchedWordConfidences === null ? 1 : 0.6 + 0.4 * matchedWordConfidences;

  const fields = Object.fromEntries(
    Object.entries(extraction.fields).map(([path, field]) => {
      const adjusted = Number(Math.min(0.99, field.confidence * ocrQualityFactor).toFixed(3));
      return [
        path,
        {
          ...field,
          confidence: adjusted,
          ...(adjusted < threshold ? { needsReview: true } : {}),
        },
      ];
    }),
  );

  const candidate: Udm = {
    udmVersion: UDM_VERSION,
    documentType: classification.documentType,
    documentTypeConfidence: Number(classification.confidence.toFixed(3)),
    source: {
      documentId: input.documentId,
      pageCount: 1,
      provider: ocr.provider,
    },
    fields,
    tables: extraction.tables,
    needsReview: true,
    warnings: extraction.warnings,
    provenance: {
      provider: ocr.provider,
      modelVersion: ocr.modelVersion,
      latencyMs: ocr.latencyMs,
      costMicros: ocr.costMicros,
    },
    extractedAt: new Date().toISOString(),
  };

  // Validate before anyone downstream sees it — providers may not dictate our shape.
  const udm = parseUdm(candidate);
  const needsReview = requiresReview(udm, threshold);
  const finalUdm: Udm = { ...udm, needsReview };

  const flagged = lowConfidenceFields(finalUdm, threshold);
  if (flagged.length > 0) {
    deps.logger.debug('extraction needs review', { fields: flagged.length });
  }

  return {
    udm: finalUdm,
    provider: ocr.provider,
    latencyMs: ocr.latencyMs,
    costMicros: ocr.costMicros,
    ocrText: ocr.text,
    words: ocr.words,
  };
}

/** Chooses the OCR provider for the current configuration (AI-004). */
export function createProviderFactory(config: {
  AI_PROVIDER: 'local' | 'cloud';
  TESSERACT_BIN: string;
  AI_CLOUD_ENDPOINT?: string;
  AI_CLOUD_API_KEY?: string;
  AI_CLOUD_MODEL: string;
  AI_MAX_COST_MICROS_PER_DOC: number;
}): () => OcrProvider {
  return () => {
    if (config.AI_PROVIDER === 'cloud') {
      return new CloudVisionProvider({
        endpoint: config.AI_CLOUD_ENDPOINT as string,
        apiKey: config.AI_CLOUD_API_KEY as string,
        model: config.AI_CLOUD_MODEL,
        maxCostMicrosPerDocument: config.AI_MAX_COST_MICROS_PER_DOC,
      });
    }
    return new TesseractProvider(config.TESSERACT_BIN);
  };
}
