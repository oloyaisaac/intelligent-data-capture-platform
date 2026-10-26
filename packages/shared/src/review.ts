/**
 * Review rules: which fields block approval, how corrections are applied, and how a bulk
 * approve decides to skip a record. Kept here so desktop, mobile and backend agree exactly.
 */

import { LIMITS } from './constants';
import type { FieldValue, Udm } from './udm/schema';

export interface ReviewThresholds {
  field: number;
  documentType: number;
}

export const DEFAULT_THRESHOLDS: ReviewThresholds = {
  field: LIMITS.reviewConfidenceThreshold,
  documentType: LIMITS.documentTypeConfidenceThreshold,
};

export interface BlockingField {
  path: string;
  reason: 'low_confidence' | 'missing_value';
  confidence: number;
}

/** Fields that must be resolved before a record can be approved. */
export function blockingFields(
  udm: Pick<Udm, 'fields' | 'documentTypeConfidence'>,
  requiredFields: string[] = [],
  thresholds: ReviewThresholds = DEFAULT_THRESHOLDS,
): BlockingField[] {
  const blocking: BlockingField[] = [];

  for (const [path, field] of Object.entries(udm.fields)) {
    if (field.value === null || field.value === '') {
      if (requiredFields.includes(path) || field.needsReview === true) {
        blocking.push({ path, reason: 'missing_value', confidence: field.confidence });
      }
      continue;
    }
    if (field.needsReview === true || field.confidence < thresholds.field) {
      blocking.push({ path, reason: 'low_confidence', confidence: field.confidence });
    }
  }

  for (const required of requiredFields) {
    if (!(required in udm.fields)) {
      blocking.push({ path: required, reason: 'missing_value', confidence: 0 });
    }
  }

  if (udm.documentTypeConfidence < thresholds.documentType) {
    blocking.push({
      path: 'documentType',
      reason: 'low_confidence',
      confidence: udm.documentTypeConfidence,
    });
  }

  return blocking.sort((a, b) => a.confidence - b.confidence);
}

export function canApprove(
  udm: Pick<Udm, 'fields' | 'documentTypeConfidence'>,
  requiredFields: string[] = [],
  thresholds: ReviewThresholds = DEFAULT_THRESHOLDS,
): { ok: boolean; blocking: BlockingField[] } {
  const blocking = blockingFields(udm, requiredFields, thresholds);
  return { ok: blocking.length === 0, blocking };
}

export interface FieldChange {
  fieldPath: string;
  value: string | number | boolean | null;
  /** Set by the caller from the authenticated session — never from the request body. */
  changedBy?: string;
}

export interface AppliedChange {
  fieldPath: string;
  before: FieldValue | null;
  after: FieldValue;
}

/**
 * Apply human corrections to a UDM record. Corrected fields become full-confidence (a human
 * asserted the value) and are marked `corrected` so learning can use them later.
 */
export function applyCorrections(
  udm: Udm,
  changes: FieldChange[],
  options: { reviewedAt?: string } = {},
): { udm: Udm; applied: AppliedChange[] } {
  const fields: Record<string, FieldValue> = { ...udm.fields };
  const applied: AppliedChange[] = [];

  for (const change of changes) {
    const before = fields[change.fieldPath] ?? null;
    const after: FieldValue = {
      ...(before ?? { type: 'string' as const, confidence: 1 }),
      value: change.value,
      confidence: 1,
      needsReview: false,
      corrected: true,
    };
    if (after.type === 'currency' && typeof change.value === 'string') {
      // A human typed text into a currency field: keep it as text but stop claiming it is currency.
      after.type = 'string';
      delete after.currency;
    }
    fields[change.fieldPath] = after;
    applied.push({ fieldPath: change.fieldPath, before, after });
  }

  const stillNeedsReview = Object.values(fields).some(
    (field) => field.needsReview === true || field.confidence < DEFAULT_THRESHOLDS.field,
  );

  return {
    udm: {
      ...udm,
      fields,
      needsReview: stillNeedsReview,
      ...(options.reviewedAt ? {} : {}),
    },
    applied,
  };
}

/** Bulk approve: keeps the batch moving but never bypasses unresolved fields. */
export function partitionForBulkApprove(
  records: Array<{
    id: string;
    udm: Pick<Udm, 'fields' | 'documentTypeConfidence'>;
    requiredFields?: string[];
  }>,
  thresholds: ReviewThresholds = DEFAULT_THRESHOLDS,
): { approvable: string[]; skipped: Array<{ id: string; blocking: BlockingField[] }> } {
  const approvable: string[] = [];
  const skipped: Array<{ id: string; blocking: BlockingField[] }> = [];

  for (const record of records) {
    const result = canApprove(record.udm, record.requiredFields ?? [], thresholds);
    if (result.ok) approvable.push(record.id);
    else skipped.push({ id: record.id, blocking: result.blocking });
  }

  return { approvable, skipped };
}
