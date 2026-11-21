// Fixed application-owned messages that may be preserved by offline historical-error remediation.
export const WORKER_OCR_ORG_LIMIT =
  'Remote OCR organisation invocation limit reached. Contact an administrator.';
export const WORKER_EXTRACTION_FAILED =
  'Document extraction failed. Investigate the worker and retry.';
export const WORKER_RETENTION_FAILED = 'Retention purge failed. Investigate storage and retry.';
export const WORKER_UNKNOWN_FAILED = 'Job failed. Investigate the job type.';
export const WORKER_REQUEUED = 'Requeued by operator after offline review.';
export const WORKER_ABANDONED = 'Abandoned by operator after offline review; not retried.';
export const WORKER_ERROR_REDACTED = 'Historical job error redacted after offline review.';
export const SAFE_WORKER_ERRORS = [
  WORKER_OCR_ORG_LIMIT,
  WORKER_EXTRACTION_FAILED,
  WORKER_RETENTION_FAILED,
  WORKER_UNKNOWN_FAILED,
  WORKER_REQUEUED,
  WORKER_ABANDONED,
  WORKER_ERROR_REDACTED,
] as const;
