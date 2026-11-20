// Application-owned batch messages safe to expose and preserve during offline remediation.
export const BATCH_FAILURE =
  'This file could not be processed. Please retry or contact an administrator.';
export const BATCH_UNSUPPORTED =
  'That file type is not supported. Upload a JPEG, PNG, HEIC image or a PDF.';
export const BATCH_TOO_LARGE = 'That file exceeds the upload size limit.';
export const BATCH_INVALID = 'That file could not be accepted. Check the file and try again.';
export const SAFE_BATCH_ERRORS = [
  BATCH_FAILURE,
  BATCH_UNSUPPORTED,
  BATCH_TOO_LARGE,
  BATCH_INVALID,
] as const;
