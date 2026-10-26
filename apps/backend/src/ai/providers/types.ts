import type { DocumentType } from '@idcp/shared';
import type { Logger } from '../../logger';

export interface OcrWord {
  text: string;
  confidence: number;
  bbox?: { x: number; y: number; width: number; height: number };
}

export interface OcrResult {
  text: string;
  words: OcrWord[];
  /** Provider that produced the text, e.g. `tesseract` or `cloud:gpt-4o-mini`. */
  provider: string;
  modelVersion?: string;
  latencyMs: number;
  costMicros: number;
}

export interface OcrInput {
  buffer: Buffer;
  mimeType: string;
  /** Optional page hint, used by providers that need a filename. */
  ordinal?: number;
}

/**
 * Provider-agnostic OCR/extraction interface (AI-004).
 * Nothing outside this folder may import a provider SDK.
 */
export interface OcrProvider {
  readonly name: string;
  /** Whether this provider can run with no network access. */
  readonly isLocal: boolean;
  ocr(input: OcrInput, context: { logger: Logger }): Promise<OcrResult>;
}

export interface ExtractionProvider extends OcrProvider {
  /** Optional: providers may classify the document themselves. */
  classify?(text: string): Promise<{ documentType: DocumentType; confidence: number } | null>;
}

/** Raised when a provider cannot do the work for an actionable reason (engine missing, budget). */
export class ProviderUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProviderUnavailableError';
  }
}
