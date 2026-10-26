import { LIMITS, type DocumentType } from '@idcp/shared';

/**
 * Document classification from OCR text (AI-002).
 *
 * A weighted keyword model rather than a black box: it is deterministic, testable, runs offline
 * and its reasoning is inspectable. When a cloud provider is configured it can supply its own
 * classification instead — the pipeline accepts either (AI-004).
 */

interface Signal {
  type: DocumentType;
  pattern: RegExp;
  weight: number;
}

const SIGNALS: Signal[] = [
  { type: 'invoice', pattern: /\binvoice\b/gi, weight: 3 },
  { type: 'invoice', pattern: /\binv[\s.#-]*(?:no|number|#)/gi, weight: 2 },
  { type: 'invoice', pattern: /\bamount\s+due\b/gi, weight: 2 },
  { type: 'invoice', pattern: /\bbill\s+to\b/gi, weight: 2 },
  { type: 'invoice', pattern: /\bdue\s+date\b/gi, weight: 1 },
  { type: 'invoice', pattern: /\bsub\s*-?total\b/gi, weight: 1 },

  { type: 'receipt', pattern: /\breceipt\b/gi, weight: 3 },
  { type: 'receipt', pattern: /\bthank\s+you\s+for\s+your\s+purchase\b/gi, weight: 2 },
  { type: 'receipt', pattern: /\bcash\b|\bchange\s+due\b|\bcard\b/gi, weight: 1 },
  { type: 'receipt', pattern: /\btill\b|\bterminal\b/gi, weight: 1 },

  { type: 'id', pattern: /\bpassport\b|\bnational\s+id\b|\bidentity\s+card\b/gi, weight: 3 },
  { type: 'id', pattern: /\bdate\s+of\s+birth\b|\bdob\b/gi, weight: 2 },
  { type: 'id', pattern: /\bplace\s+of\s+birth\b|\bexpiry\s+date\b|\bsex\b/gi, weight: 1 },

  { type: 'contract', pattern: /\bagreement\b|\bcontract\b/gi, weight: 3 },
  { type: 'contract', pattern: /\bparty\b|\bparties\b|\bwhereas\b/gi, weight: 2 },
  { type: 'contract', pattern: /\bsignature\b|\bwitness\b|\bgoverned\s+by\b/gi, weight: 1 },

  { type: 'form', pattern: /\bform\b|\bapplication\b|\bquestionnaire\b/gi, weight: 2 },
  { type: 'form', pattern: /\bsurname\b|\bfirst\s+name\b|\bdate\b/gi, weight: 1 },

  { type: 'table', pattern: /(?:\S+\s{2,}){2,}\S+/g, weight: 1 },
];

const COLUMN_HEADER_SIGNALS = /\b(description|qty|quantity|unit\s+price|amount|total)\b/gi;

/** Very high ratio of non-alphanumeric or unusual characters hints at handwriting OCR noise. */
function handwritingLikelihood(text: string): number {
  const letters = (text.match(/[A-Za-z]/g) ?? []).length;
  const words = (text.match(/\S+/g) ?? []).length;
  if (words === 0) return 0;
  const averageWordLength = letters / words;
  const digitRatio = (text.match(/\d/g) ?? []).length / Math.max(text.length, 1);
  // Handwriting OCR tends to produce short, broken tokens.
  if (averageWordLength < 3.2 && words > 12) return 0.6;
  if (digitRatio > 0.45) return 0.3;
  return 0;
}

export interface Classification {
  documentType: DocumentType;
  confidence: number;
  scores: Record<string, number>;
}

export function classifyDocument(text: string): Classification {
  const body = text ?? '';
  const scores: Record<string, number> = {};

  for (const signal of SIGNALS) {
    const matches = body.match(signal.pattern);
    if (matches && matches.length > 0) {
      scores[signal.type] =
        (scores[signal.type] ?? 0) + signal.weight * Math.min(matches.length, 3);
    }
  }

  const columnHeaders = (body.match(COLUMN_HEADER_SIGNALS) ?? []).length;
  if (columnHeaders >= 3) scores.table = (scores.table ?? 0) + 2;

  const handwriting = handwritingLikelihood(body);
  if (handwriting >= 0.5) scores.handwritten = (scores.handwritten ?? 0) + handwriting * 4;

  const entries = Object.entries(scores).sort(([, a], [, b]) => b - a);
  if (entries.length === 0 || (entries[0]?.[1] ?? 0) < 2) {
    return { documentType: 'unknown', confidence: 0.2, scores };
  }

  const [bestType, bestScore] = entries[0]!;
  const secondScore = entries[1]?.[1] ?? 0;
  const total = entries.reduce((sum, [, score]) => sum + score, 0);

  // Confidence blends share of evidence with the margin over the runner-up, so a document that
  // scores equally for invoice and receipt is reported as uncertain rather than coin-flipped.
  const share = bestScore / total;
  const margin = bestScore === 0 ? 0 : (bestScore - secondScore) / bestScore;
  const raw = 0.5 * share + 0.5 * margin;
  const confidence = Math.max(0.2, Math.min(0.98, Number(raw.toFixed(3))));

  return {
    documentType: bestType as DocumentType,
    confidence,
    scores,
  };
}

/** True when the classification is too uncertain to trust without a human (AI-002). */
export function isClassificationUncertain(
  classification: Classification,
  threshold: number = LIMITS.documentTypeConfidenceThreshold,
): boolean {
  return classification.confidence < threshold;
}
