/**
 * Duplicate detection helpers (see PRD.json DUP-001).
 *
 * Two records are compared on configured keys (e.g. invoice number + supplier tax id) and on
 * a fuzzy score over normalised text. The score is advisory: the policy decides what happens,
 * and a human-visible score is always shown in the UI.
 */

import { LIMITS } from './constants';

/**
 * Business-name abbreviations that mean the same thing on a document.
 * Without this, "Acme Limited" and "Acme Ltd" score ~0.67 and a real duplicate is missed.
 */
const NAME_ALIASES: Record<string, string> = {
  limited: 'ltd',
  company: 'co',
  corporation: 'corp',
  incorporated: 'inc',
  enterprises: 'ent',
  international: 'intl',
};

/** Normalise a value for comparison: lowercase, fold accents, expand abbreviations, strip punctuation. */
export function normaliseKeyValue(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'number') return String(value);
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (value instanceof Date) return value.toISOString();
  return String(value)
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ')
    .split(' ')
    .map((token) => NAME_ALIASES[token] ?? token)
    .join(' ');
}

/** Levenshtein distance with a rolling array (memory O(min(a,b))). */
export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;

  const short = a.length <= b.length ? a : b;
  const long = a.length <= b.length ? b : a;
  let previous = Array.from({ length: short.length + 1 }, (_, index) => index);

  for (let rowIndex = 1; rowIndex <= long.length; rowIndex += 1) {
    const current = [rowIndex];
    for (let columnIndex = 1; columnIndex <= short.length; columnIndex += 1) {
      const cost = long[rowIndex - 1] === short[columnIndex - 1] ? 0 : 1;
      current[columnIndex] = Math.min(
        (current[columnIndex - 1] ?? 0) + 1,
        (previous[columnIndex] ?? 0) + 1,
        (previous[columnIndex - 1] ?? 0) + cost,
      );
    }
    previous = current;
  }
  return previous[short.length] ?? 0;
}

/** Similarity in [0,1] based on normalised edit distance. */
export function similarity(a: string, b: string): number {
  const left = normaliseKeyValue(a);
  const right = normaliseKeyValue(b);
  if (!left && !right) return 1;
  if (!left || !right) return 0;
  const distance = levenshtein(left, right);
  return 1 - distance / Math.max(left.length, right.length);
}

/** Fuzzy score over a set of fields; returns 0..1. */
export function fuzzyScore(
  candidate: Record<string, unknown>,
  existing: Record<string, unknown>,
  fields: string[],
): number {
  if (fields.length === 0) return 0;
  const scores = fields.map((field) =>
    similarity(safeString(candidate[field]), safeString(existing[field])),
  );
  return scores.reduce((sum, score) => sum + score, 0) / scores.length;
}

function safeString(value: unknown): string {
  return value === null || value === undefined ? '' : String(value);
}

export interface DuplicateMatch {
  /** Score 0..1; 1 means an exact match on the configured keys. */
  score: number;
  /** Keys that matched exactly after normalisation. */
  matchedKeys: string[];
  /** True when the score meets the configured threshold. */
  isDuplicate: boolean;
}

/**
 * Compare two records on exact (normalised) duplicate keys, falling back to fuzzy similarity
 * when no key matches exactly.
 */
export function matchDuplicate(
  candidate: Record<string, unknown>,
  existing: Record<string, unknown>,
  keys: string[],
  options: { threshold?: number; fuzzyFields?: string[] } = {},
): DuplicateMatch {
  const threshold = options.threshold ?? LIMITS.duplicateScoreThreshold;
  const matchedKeys = keys.filter((key) => {
    const left = normaliseKeyValue(candidate[key]);
    const right = normaliseKeyValue(existing[key]);
    return left !== '' && left === right;
  });

  if (keys.length > 0 && matchedKeys.length === keys.length) {
    return { score: 1, matchedKeys, isDuplicate: true };
  }
  if (matchedKeys.length > 0) {
    const score = matchedKeys.length / keys.length;
    return { score, matchedKeys, isDuplicate: score >= threshold };
  }

  const fuzzyFields = options.fuzzyFields ?? keys;
  const score = fuzzyScore(candidate, existing, fuzzyFields);
  return { score, matchedKeys: [], isDuplicate: score >= threshold };
}

/**
 * Find the best duplicate among existing records.
 * Linear scan is deliberate: candidate sets are per-document and small; a trigram index in the
 * database handles bulk imports (see DATABASE.md §5).
 */
export function findBestDuplicate(
  candidate: Record<string, unknown>,
  existing: Record<string, unknown>[],
  keys: string[],
  options: { threshold?: number; fuzzyFields?: string[] } = {},
): { match: DuplicateMatch; record: Record<string, unknown> } | null {
  let best: { match: DuplicateMatch; record: Record<string, unknown> } | null = null;
  for (const record of existing) {
    const match = matchDuplicate(candidate, record, keys, options);
    if (!best || match.score > best.match.score) best = { match, record };
  }
  return best && best.match.isDuplicate ? best : null;
}

export interface MergeConflict {
  field: string;
  /** The value that was kept (from the existing row / the human review). */
  kept: unknown;
  /** The incoming value that was not written. */
  ignored: unknown;
  reason: 'reviewed' | 'key';
}

export interface MergeOutcome {
  values: Record<string, string | number | boolean | null>;
  conflicts: MergeConflict[];
  /** Fields that changed, so the run summary can say what the merge actually did. */
  changedFields: string[];
}

/**
 * Merge an incoming record into an existing row (DUP-001).
 *
 * Two rules matter here:
 *   - a **reviewed** field is never overwritten. A human confirmed that value; a later automated
 *     import must not silently replace it.
 *   - a **duplicate key** is never overwritten either, or the row would stop being the same row.
 *
 * Everything else takes the incoming value when it is present, and keeps the existing value when
 * the incoming field is empty (a mapping that could not read a field must not blank the row).
 * Every ignored value is reported as a conflict, so "nothing was discarded silently" is provable.
 */
export function mergeRecord(
  existing: Record<string, string | number | boolean | null>,
  incoming: Record<string, string | number | boolean | null>,
  options: { keys?: string[]; reviewedFields?: string[] } = {},
): MergeOutcome {
  const keys = new Set(options.keys ?? []);
  const reviewed = new Set(options.reviewedFields ?? []);
  const values: Record<string, string | number | boolean | null> = { ...existing };
  const conflicts: MergeConflict[] = [];
  const changedFields: string[] = [];

  for (const [field, next] of Object.entries(incoming)) {
    if (next === null || next === undefined || next === '') continue;
    const current = existing[field] ?? null;

    if (keys.has(field)) {
      if (current !== next) {
        conflicts.push({ field, kept: current, ignored: next, reason: 'key' });
      }
      continue;
    }

    if (reviewed.has(field) && current !== null && current !== next) {
      conflicts.push({ field, kept: current, ignored: next, reason: 'reviewed' });
      continue;
    }

    if (current !== next) {
      values[field] = next;
      changedFields.push(field);
    }
  }

  return { values, conflicts, changedFields };
}
