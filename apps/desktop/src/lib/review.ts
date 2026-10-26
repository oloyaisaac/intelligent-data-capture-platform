import type {
  ReviewBlockingField as BlockingField,
  Translate,
  TranslationKey,
  Udm,
} from '@idcp/shared';

/**
 * Review helpers (REV-001).
 *
 * The rules that decide what a reviewer sees first and what may be approved live here so the
 * desktop, the phone and the server agree — the server remains the authority; this only sorts and
 * labels.
 */

export interface ReviewFieldRow {
  path: string;
  label: string;
  value: string;
  type: string;
  confidence: number;
  needsReview: boolean;
  reason: BlockingField['reason'] | null;
}

const REASON_KEYS: Record<string, TranslationKey> = {
  low_confidence: 'review.reason.lowConfidence',
  missing_value: 'review.reason.missingValue',
  not_found: 'review.reason.notFound',
  not_processed: 'review.reason.notProcessed',
};

/**
 * The reason a field needs attention, in the reader's language.
 *
 * Without a translator the English label is returned, so the pure helper still works in isolation.
 */
export function blockingReasonLabel(reason: string, t?: Translate): string {
  const key = REASON_KEYS[reason];
  if (t) return t(key ?? 'review.reason.attention');
  switch (key) {
    case 'review.reason.lowConfidence':
      return 'Low confidence';
    case 'review.reason.missingValue':
      return 'Missing value';
    case 'review.reason.notFound':
      return 'Not found';
    case 'review.reason.notProcessed':
      return 'Not processed';
    default:
      return 'Needs attention';
  }
}

/**
 * Flattens UDM fields into rows and puts the riskiest first: missing values, then lowest
 * confidence. Fields the reviewer already confirmed sort last, because they need no attention.
 */
export function reviewRows(udm: Udm, blocking: BlockingField[]): ReviewFieldRow[] {
  const blockingByPath = new Map(blocking.map((entry) => [entry.path, entry]));

  const rows: ReviewFieldRow[] = Object.entries(udm.fields)
    // Tables are reviewed as a whole below the field list, not one field at a time.
    .filter(([, field]) => field.type !== 'table')
    .map(([path, field]) => {
      const blocker = blockingByPath.get(path);
      const isMissing = field.value === null || field.value === '';
      return {
        path,
        label: field.label ?? path,
        value: field.value === null || field.value === '' ? '' : String(field.value),
        type: field.type,
        confidence: field.confidence,
        needsReview: Boolean(blocker) || field.needsReview === true || isMissing,
        reason: blocker?.reason ?? (isMissing ? 'missing_value' : null),
      };
    });

  // Template fields that were expected but are entirely absent from the record still need a row.
  for (const blocker of blocking) {
    if (blocker.path === 'documentType') continue;
    if (rows.some((row) => row.path === blocker.path)) continue;
    rows.push({
      path: blocker.path,
      label: blocker.path,
      value: '',
      type: 'string',
      confidence: blocker.confidence,
      needsReview: true,
      reason: blocker.reason,
    });
  }

  return rows.sort(
    (a, b) => rank(a) - rank(b) || a.confidence - b.confidence || a.path.localeCompare(b.path),
  );
}

function rank(row: ReviewFieldRow): number {
  if (row.reason === 'missing_value' || row.value === '') return 0;
  if (row.needsReview) return 1;
  return 2;
}

export function blockingCount(blocking: BlockingField[]): number {
  return blocking.length;
}

/** Approval is offered only when nothing is unresolved — the button also explains why not. */
export function canApprove(blocking: BlockingField[]): boolean {
  return blocking.length === 0;
}

export function documentTypeReason(blocking: BlockingField[]): BlockingField | null {
  return blocking.find((entry) => entry.path === 'documentType') ?? null;
}

/** Records that may be bulk-approved: those with no unresolved fields. */
export function bulkApprovable(
  documentIds: string[],
  blockingByDocument: Record<string, BlockingField[]>,
): string[] {
  return documentIds.filter((id) => (blockingByDocument[id]?.length ?? 0) === 0);
}

export interface PendingChange {
  fieldPath: string;
  value: string | number | boolean | null;
}

/** Builds the PATCH body from edited inputs, ignoring values the reviewer did not change. */
export function pendingChanges(
  rows: ReviewFieldRow[],
  edited: Record<string, string>,
): PendingChange[] {
  const changes: PendingChange[] = [];
  for (const row of rows) {
    if (!(row.path in edited)) continue;
    const next = edited[row.path]!;
    if (next === row.value) continue;
    changes.push({ fieldPath: row.path, value: coerce(next, row.type) });
  }
  return changes;
}

function coerce(value: string, type: string): string | number | boolean | null {
  const trimmed = value.trim();
  if (trimmed === '') return null;
  if (type === 'number' || type === 'currency') {
    const numeric = Number(trimmed.replace(/[^0-9.-]/g, ''));
    return Number.isFinite(numeric) ? numeric : trimmed;
  }
  if (type === 'boolean') {
    if (/^(true|yes|1)$/i.test(trimmed)) return true;
    if (/^(false|no|0)$/i.test(trimmed)) return false;
  }
  return trimmed;
}
