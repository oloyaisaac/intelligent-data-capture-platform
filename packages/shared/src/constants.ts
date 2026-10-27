/**
 * Shared constants: limits, thresholds, status vocabularies and roles.
 * These are the single source of truth for values used by mobile, desktop and backend.
 */

/** Version of the Universal Data Model. Bump the major on breaking changes. */
export const UDM_VERSION = '1.0';

/**
 * Version of the legal pack in `legal/` (privacy policy, terms, DPA).
 *
 * Stored against every account that accepts the terms, so a contract can be proved years later and a
 * material change can be re-presented: bump this string in the same commit that changes the documents.
 * `legal/README.md` records the rule.
 */
export const LEGAL_VERSION = '2026-10';

/** Roles, ordered from most to least privileged. */
export const ROLES = ['owner', 'admin', 'reviewer', 'operator', 'viewer'] as const;
export type Role = (typeof ROLES)[number];

const ROLE_RANK: Record<Role, number> = { owner: 5, admin: 4, reviewer: 3, operator: 2, viewer: 1 };

export function roleAtLeast(role: Role, required: Role): boolean {
  return ROLE_RANK[role] >= ROLE_RANK[required];
}

/** Document lifecycle. Transitions are enforced in the document service. */
export const DOCUMENT_STATUSES = [
  'uploaded',
  'queued',
  'processing',
  'extracted',
  'needs_review',
  'approved',
  'failed',
  'deleted',
] as const;
export type DocumentStatus = (typeof DOCUMENT_STATUSES)[number];

export const JOB_STATUSES = ['queued', 'running', 'succeeded', 'failed', 'dead'] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];

export const REVIEW_STATUSES = ['in_progress', 'approved', 'rejected'] as const;
export type ReviewStatus = (typeof REVIEW_STATUSES)[number];

export const DOCUMENT_TYPES = [
  'form',
  'receipt',
  'invoice',
  'id',
  'contract',
  'table',
  'handwritten',
  'unknown',
] as const;
export type DocumentType = (typeof DOCUMENT_TYPES)[number];

export const PAIRING_STATUSES = ['pending', 'completed', 'expired', 'cancelled'] as const;
export type PairingStatus = (typeof PAIRING_STATUSES)[number];

export const DUPLICATE_POLICIES = ['skip', 'update', 'append', 'merge'] as const;
export type DuplicatePolicy = (typeof DUPLICATE_POLICIES)[number];

/**
 * Destination types a mapping profile can be created for (CON-001, CRM-001).
 *
 * The list is the contract between the connector registry and the API: a type that is registered but
 * missing here would be rejected as "invalid" by `POST /connectors`.
 */
export const CONNECTOR_TYPES = [
  'csv',
  'xlsx',
  'google_sheets',
  'postgres',
  'mysql',
  'sqlite',
  'hubspot',
  'odoo',
  'quickbooks',
] as const;
export type ConnectorType = (typeof CONNECTOR_TYPES)[number];

/** Limits. Defaults mirror `.env.example`; the backend may tighten them at runtime. */
export const LIMITS = {
  /** Max size of a single uploaded image/PDF. */
  maxUploadBytes: 20 * 1024 * 1024,
  /** Max size of the whole multipart request. */
  maxRequestBytes: 50 * 1024 * 1024,
  /** Allowed upload MIME types (content-sniffed, never trusted from headers). */
  allowedUploadMimeTypes: ['image/jpeg', 'image/png', 'image/heic', 'application/pdf'] as const,
  /** Pagination defaults. */
  defaultPageSize: 25,
  maxPageSize: 100,
  /** Pairing token lifetime. */
  pairingTokenTtlSeconds: 120,
  /** Access / refresh token lifetimes. */
  accessTokenTtlSeconds: 900,
  refreshTokenTtlSeconds: 30 * 24 * 60 * 60,
  /** Password policy. */
  minPasswordLength: 12,
  maxPasswordLength: 256,
  /** Field confidence below this value must be reviewed by a human. */
  reviewConfidenceThreshold: 0.85,
  /** Document classification below this value is flagged. */
  documentTypeConfidenceThreshold: 0.7,
  /** Duplicate detection: score above this means "likely the same record". */
  duplicateScoreThreshold: 0.9,
  /** Magic-byte sniffing reads at most this many bytes. */
  sniffBytes: 64,
} as const;

/** Field types supported by the Universal Data Model. */
export const FIELD_TYPES = ['string', 'number', 'currency', 'date', 'boolean', 'table'] as const;
export type FieldType = (typeof FIELD_TYPES)[number];

/** Error codes returned by the API. Keep stable: clients match on these. */
export const ERROR_CODES = {
  FIELD_VALIDATION_FAILED: 400,
  INVALID_JSON: 400,
  UNAUTHENTICATED: 401,
  TOKEN_EXPIRED: 401,
  INVALID_CREDENTIALS: 401,
  FORBIDDEN: 403,
  ROLE_REQUIRED: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  DUPLICATE_KEY: 409,
  PAYLOAD_TOO_LARGE: 413,
  UNSUPPORTED_MEDIA_TYPE: 415,
  UNPROCESSABLE: 422,
  PAIRING_TOKEN_EXPIRED: 422,
  PAIRING_TOKEN_USED: 422,
  RATE_LIMITED: 429,
  INTERNAL_ERROR: 500,
} as const;

export type ErrorCode = keyof typeof ERROR_CODES;

/** Audit actions. Always `<entity>.<verb>` so logs are easy to filter. */
export const AUDIT_ACTIONS = [
  'api_key.created',
  'api_key.revoked',
  'auth.login',
  'auth.login_failed',
  'auth.logout',
  'auth.password_changed',
  'auth.password_reset',
  'auth.password_reset_requested',
  'auth.register',
  'auth.session_revoked',
  'auth.sessions_revoked_all',
  'audit.exported',
  'batch.created',
  'connector.created',
  'connector.deleted',
  'connector.run',
  'connector.updated',
  'device.paired',
  'device.renamed',
  'device.revoked',
  'document.approved',
  'document.deleted',
  'document.field_corrected',
  'document.rejected',
  'document.reprocessed',
  'document.uploaded',
  'document.viewed',
  'export.created',
  'export.downloaded',
  'legal.terms_accepted',
  'mapping.created',
  'marketplace.package_installed',
  'marketplace.package_rolled_back',
  'organisation.updated',
  'privacy.account_erased',
  'project.archived',
  'project.created',
  'retention.purged',
  'review.corrections_exported',
  'template.created',
  'template.disabled',
  'user.invitation_accepted',
  'user.invited',
  'user.removed',
  'user.role_changed',
  'workflow.created',
  'workflow.run_approved',
] as const;
export type AuditAction = (typeof AUDIT_ACTIONS)[number];
