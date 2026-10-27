import { z } from 'zod';
import {
  CONNECTOR_TYPES,
  DOCUMENT_TYPES,
  DUPLICATE_POLICIES,
  LIMITS,
  ROLES,
  UDM_VERSION,
} from './constants';
import { UdmSchema } from './udm/schema';

/**
 * Wire contracts shared by the backend and both clients.
 * Every request body is validated with these schemas at the HTTP boundary (SECURITY.md §7).
 */

export const EmailSchema = z.string().trim().toLowerCase().email().max(254);
export const PasswordSchema = z
  .string()
  .min(
    LIMITS.minPasswordLength,
    `Password must be at least ${LIMITS.minPasswordLength} characters.`,
  )
  .max(LIMITS.maxPasswordLength);

export const PaginationSchema = z.object({
  limit: z.coerce.number().int().min(1).max(LIMITS.maxPageSize).default(LIMITS.defaultPageSize),
  cursor: z.string().max(200).optional(),
});

/**
 * Acceptance of the terms at sign-up.
 *
 * `z.literal(true)` rather than a boolean: a client cannot create an account by omitting the field or
 * sending `false`, and the record of *what* was accepted is written server-side (DEC-032).
 */
export const TermsAcceptanceSchema = z
  .object({
    acceptedAt: z.string().nullable(),
    version: z.string().nullable(),
    /** False when the pack has been revised since this account accepted it. */
    current: z.boolean(),
  })
  .strict();
export type TermsAcceptance = z.infer<typeof TermsAcceptanceSchema>;

export const RegisterRequestSchema = z
  .object({
    email: EmailSchema,
    password: PasswordSchema,
    displayName: z.string().trim().min(1).max(120),
    organisationName: z.string().trim().min(2).max(120),
    /** The sign-up form's "I accept the Terms and the Privacy Policy" checkbox. */
    acceptTerms: z.literal(true),
  })
  .strict();
export type RegisterRequest = z.infer<typeof RegisterRequestSchema>;

export const LoginRequestSchema = z
  .object({
    email: EmailSchema,
    password: z.string().min(1).max(LIMITS.maxPasswordLength),
  })
  .strict();
export type LoginRequest = z.infer<typeof LoginRequestSchema>;

export const RefreshRequestSchema = z
  .object({ refreshToken: z.string().min(20).max(500) })
  .strict();

export const UserSummarySchema = z.object({
  id: z.string(),
  email: z.string(),
  displayName: z.string(),
  role: z.enum(ROLES),
  organisationId: z.string(),
  organisationName: z.string(),
  /** Only `GET /auth/me` fills this in; a token pair does not need it. */
  terms: TermsAcceptanceSchema.optional(),
});
export type UserSummary = z.infer<typeof UserSummarySchema>;

export const TokenPairSchema = z.object({
  accessToken: z.string(),
  expiresIn: z.number().int().positive(),
  refreshToken: z.string(),
  /** Identifies the server-side session this token pair belongs to (session list, revocation). */
  sessionId: z.string(),
  user: UserSummarySchema,
});
export type TokenPair = z.infer<typeof TokenPairSchema>;

// --- Account recovery and session control ----------------------------------

/** POST /auth/password/forgot — always answers the same way, whatever the address. */
export const ForgotPasswordRequestSchema = z.object({ email: EmailSchema }).strict();
export type ForgotPasswordRequest = z.infer<typeof ForgotPasswordRequestSchema>;

export const ForgotPasswordResponseSchema = z.object({
  /** True when a reset link would have been sent. Never says whether the account exists. */
  accepted: z.literal(true),
  /**
   * Only present outside production, where there is no mail transport: it lets a developer finish
   * the flow locally. A production response never contains a token (DEC-030).
   */
  resetUrl: z.string().url().optional(),
});
export type ForgotPasswordResponse = z.infer<typeof ForgotPasswordResponseSchema>;

export const ResetPasswordRequestSchema = z
  .object({
    token: z.string().min(20).max(500),
    password: PasswordSchema,
  })
  .strict();
export type ResetPasswordRequest = z.infer<typeof ResetPasswordRequestSchema>;

/** POST /auth/password/change — the current refresh token is kept alive, every other one is not. */
export const ChangePasswordRequestSchema = z
  .object({
    currentPassword: z.string().min(1).max(LIMITS.maxPasswordLength),
    newPassword: PasswordSchema,
    /** Optional: the caller's own session, so it is not signed out by its own password change. */
    refreshToken: z.string().min(20).max(500).optional(),
  })
  .strict();
export type ChangePasswordRequest = z.infer<typeof ChangePasswordRequestSchema>;

export const SessionSchema = z.object({
  id: z.string(),
  createdAt: z.string(),
  expiresAt: z.string(),
  userAgent: z.string().nullable(),
  current: z.boolean(),
});
export type Session = z.infer<typeof SessionSchema>;

export const SessionListSchema = z.object({ items: z.array(SessionSchema) });
export type SessionList = z.infer<typeof SessionListSchema>;

// --- Privacy (data-subject rights) ----------------------------------------

/** GET /me/export — everything the platform holds about the person who asked. */
export const DataExportSchema = z.object({
  generatedAt: z.string(),
  formatVersion: z.literal(1),
  account: z.object({
    id: z.string(),
    email: z.string(),
    displayName: z.string(),
    locale: z.string(),
    createdAt: z.string(),
    lastLoginAt: z.string().nullable(),
  }),
  organisations: z.array(
    z.object({ id: z.string(), name: z.string(), role: z.string(), joinedAt: z.string() }),
  ),
  documents: z.array(
    z.object({
      id: z.string(),
      documentType: z.string(),
      mimeType: z.string(),
      status: z.string(),
      createdAt: z.string(),
    }),
  ),
  reviews: z.array(
    z.object({
      id: z.string(),
      documentId: z.string(),
      status: z.string(),
      createdAt: z.string(),
    }),
  ),
  auditEntries: z.array(
    z.object({
      action: z.string(),
      targetType: z.string().nullable(),
      createdAt: z.string(),
    }),
  ),
  notes: z.array(z.string()),
});
export type DataExport = z.infer<typeof DataExportSchema>;

/** POST /me/erase — anonymise the account; organisation records are kept and explained. */
export const EraseAccountRequestSchema = z
  .object({
    password: z.string().min(1).max(LIMITS.maxPasswordLength),
    confirm: z.literal('DELETE'),
  })
  .strict();
export type EraseAccountRequest = z.infer<typeof EraseAccountRequestSchema>;

export const EraseAccountResponseSchema = z.object({
  erased: z.literal(true),
  anonymisedAt: z.string(),
  retainedRecords: z.string(),
});
export type EraseAccountResponse = z.infer<typeof EraseAccountResponseSchema>;

/** POST /pairing/sessions — created by the desktop app. */
export const CreatePairingSessionResponseSchema = z.object({
  id: z.string(),
  token: z.string(),
  endpoint: z.string().url(),
  expiresAt: z.string(),
  expiresInSeconds: z.number().int().positive(),
  qrPayload: z.string(),
});
export type CreatePairingSessionResponse = z.infer<typeof CreatePairingSessionResponseSchema>;

/** POST /pairing/complete — sent by the phone after scanning. */
export const CompletePairingRequestSchema = z
  .object({
    token: z.string().min(20).max(200),
    device: z
      .object({
        name: z.string().trim().min(1).max(80),
        platform: z.enum(['android', 'ios', 'desktop']),
        appVersion: z.string().trim().max(40).optional(),
      })
      .strict(),
  })
  .strict();
export type CompletePairingRequest = z.infer<typeof CompletePairingRequestSchema>;

export const CompletePairingResponseSchema = z.object({
  deviceId: z.string(),
  deviceCredential: z.string(),
  organisationId: z.string(),
  deviceName: z.string(),
});
export type CompletePairingResponse = z.infer<typeof CompletePairingResponseSchema>;

export const DeviceSchema = z.object({
  id: z.string(),
  name: z.string(),
  platform: z.enum(['android', 'ios', 'desktop']),
  appVersion: z.string().nullable().optional(),
  lastSeenAt: z.string().nullable().optional(),
  revokedAt: z.string().nullable().optional(),
  createdAt: z.string(),
});
export type Device = z.infer<typeof DeviceSchema>;

/**
 * Upload acknowledgement (DOC-001). A retry carrying the same `Idempotency-Key` returns the
 * original document with `duplicate: true` and status 200 instead of creating a second record.
 */
export const DocumentUploadResponseSchema = z.object({
  id: z.string(),
  status: z.string(),
  document: z.lazy(() => DocumentSchema),
  jobId: z.string(),
  duplicate: z.boolean(),
});
export type DocumentUploadResponse = z.infer<typeof DocumentUploadResponseSchema>;

export const DocumentListResponseSchema = z.object({
  items: z.array(z.lazy(() => DocumentSchema)),
  nextCursor: z.string().nullable(),
});
export type DocumentListResponse = z.infer<typeof DocumentListResponseSchema>;

export const DocumentSchema = z.object({
  id: z.string(),
  status: z.string(),
  documentType: z.enum(DOCUMENT_TYPES),
  mimeType: z.string(),
  sizeBytes: z.number().int(),
  pageCount: z.number().int(),
  createdAt: z.string(),
  updatedAt: z.string(),
  deletedAt: z.string().nullable().optional(),
});
export type DocumentSummary = z.infer<typeof DocumentSchema>;

export const ExtractionResultSchema = z.object({
  documentId: z.string(),
  extractionId: z.string(),
  attempt: z.number().int(),
  udmVersion: z.string(),
  provider: z.string(),
  confidence: z.number(),
  needsReview: z.boolean(),
  udm: z.unknown(),
  createdAt: z.string(),
});
export type ExtractionResult = z.infer<typeof ExtractionResultSchema>;

export const FieldChangeSchema = z
  .object({
    fieldPath: z.string().min(1).max(200),
    value: z.union([z.string().max(10_000), z.number(), z.boolean(), z.null()]),
  })
  .strict();

export const PatchFieldsRequestSchema = z
  .object({
    changes: z.array(FieldChangeSchema).max(200).default([]),
    /** A reviewer may confirm or correct the classification itself (REV-001). */
    documentType: z.enum(DOCUMENT_TYPES).optional(),
  })
  .strict()
  .refine(
    (value) => value.changes.length > 0 || value.documentType !== undefined,
    'Provide at least one field change or a document type.',
  );
export type PatchFieldsRequest = z.infer<typeof PatchFieldsRequestSchema>;

export const ApproveRequestSchema = z
  .object({ notes: z.string().max(2000).optional() })
  .strict()
  .optional();

export const RejectRequestSchema = z
  .object({ reason: z.string().trim().min(1).max(2000) })
  .strict();

export const BulkApproveRequestSchema = z
  .object({ documentIds: z.array(z.string().uuid()).min(1).max(200) })
  .strict();

export const CreateExportRequestSchema = z
  .object({
    format: z.enum(['xlsx', 'csv']),
    documentType: z.enum(DOCUMENT_TYPES).optional(),
    from: z.string().datetime().optional(),
    to: z.string().datetime().optional(),
    delimiter: z.enum([',', ';', '\t', '|']).optional(),
    /** Optional column projection; defaults to the standard field order. */
    columns: z.array(z.string().max(200)).max(100).optional(),
    bom: z.boolean().optional(),
  })
  .strict();
export type CreateExportRequest = z.infer<typeof CreateExportRequestSchema>;

export const ExportSchema = z.object({
  id: z.string(),
  format: z.enum(['xlsx', 'csv']),
  status: z.enum(['queued', 'ready', 'failed', 'expired']),
  rowCount: z.number().int().nullable().optional(),
  downloadUrl: z.string().nullable().optional(),
  expiresAt: z.string().nullable().optional(),
  /** Present when the request asked for a document type; echoes the filters used. */
  review: z.string().nullable().optional(),
  createdAt: z.string(),
});
export type ExportRecord = z.infer<typeof ExportSchema>;

export const ConnectorConfigSchema = z.record(z.string(), z.unknown());

export const CreateConnectorRequestSchema = z
  .object({
    type: z.enum(CONNECTOR_TYPES),
    name: z.string().trim().min(1).max(80),
    config: ConnectorConfigSchema,
    credentials: z.record(z.string(), z.string()).optional(),
  })
  .strict();
export type CreateConnectorRequest = z.infer<typeof CreateConnectorRequestSchema>;

export const ConnectorSchema = z.object({
  id: z.string(),
  type: z.string(),
  name: z.string(),
  status: z.enum(['active', 'disabled', 'error']),
  config: ConnectorConfigSchema,
  lastHealthCheckAt: z.string().nullable().optional(),
  lastError: z.string().nullable().optional(),
  createdAt: z.string(),
});
export type Connector = z.infer<typeof ConnectorSchema>;

export const MappingFieldSchema = z
  .object({
    udmPath: z.string().min(1).max(200),
    destinationField: z.string().min(1).max(120),
    transform: z
      .enum(['none', 'date_iso', 'number', 'boolean', 'uppercase', 'trim'])
      .default('none'),
    defaultValue: z.union([z.string(), z.number(), z.boolean()]).optional(),
    required: z.boolean().default(false),
  })
  .strict();

export const CreateMappingProfileRequestSchema = z
  .object({
    connectorId: z.string().uuid().nullable().optional(),
    documentType: z.enum(DOCUMENT_TYPES),
    name: z.string().trim().min(1).max(80),
    fieldMap: z.array(MappingFieldSchema).min(1).max(200),
    duplicatePolicy: z.enum(DUPLICATE_POLICIES).default('skip'),
    duplicateKeys: z.array(z.string().max(200)).max(10).default([]),
  })
  .strict();
export type CreateMappingProfileRequest = z.infer<typeof CreateMappingProfileRequestSchema>;

export const SendDocumentRequestSchema = z
  .object({ connectorId: z.string().uuid(), mappingProfileId: z.string().uuid() })
  .strict();

export const DuplicateCandidateSchema = z.object({
  /** 0..1; 1 means an exact match on every configured duplicate key. */
  score: z.number(),
  matchedKeys: z.array(z.string()),
  /** The destination row, so a reviewer can confirm it is the same invoice. */
  values: z.record(z.string(), z.unknown()),
});
export type DuplicateCandidate = z.infer<typeof DuplicateCandidateSchema>;

export const DuplicateCheckResponseSchema = z.object({
  connectorId: z.string(),
  mappingProfileId: z.string(),
  documentId: z.string(),
  keys: z.array(z.string()),
  policy: z.enum(DUPLICATE_POLICIES),
  threshold: z.number(),
  /** True when the best candidate meets the policy threshold. */
  isDuplicate: z.boolean(),
  /** Score of the best candidate, 0 when the destination is empty. */
  bestScore: z.number(),
  matchedKeys: z.array(z.string()),
  candidates: z.array(DuplicateCandidateSchema),
});
export type DuplicateCheckResponse = z.infer<typeof DuplicateCheckResponseSchema>;

export const UpdateOrganisationRequestSchema = z
  .object({
    name: z.string().trim().min(2).max(120).optional(),
    retentionDays: z.number().int().min(0).max(3650).optional(),
    aiProvider: z.enum(['local', 'cloud']).optional(),
    /** REV-002: corrections may only be used to improve extraction after explicit opt-in. */
    learningOptIn: z.boolean().optional(),
  })
  .strict();

export const InviteUserRequestSchema = z
  .object({
    email: EmailSchema,
    role: z.enum(ROLES),
  })
  .strict();

export const UpdateRoleRequestSchema = z.object({ role: z.enum(ROLES) }).strict();

// --- Correction statistics (REV-002) --------------------------------------

export const CorrectionStatSchema = z.object({
  fieldPath: z.string(),
  corrections: z.number().int(),
  averageConfidence: z.number().nullable(),
});
export type CorrectionStat = z.infer<typeof CorrectionStatSchema>;

export const CorrectionStatsResponseSchema = z.object({
  /** Whether this organisation allows corrections to be used for training. */
  optIn: z.boolean(),
  total: z.number().int(),
  byField: z.array(CorrectionStatSchema),
  byDocumentType: z.array(
    z.object({
      documentType: z.string().nullable(),
      corrections: z.number().int(),
      averageConfidence: z.number().nullable(),
    }),
  ),
});
export type CorrectionStatsResponse = z.infer<typeof CorrectionStatsResponseSchema>;

// --- Audit trail (AUDIT-001) --------------------------------------------

export const AuditLogEntrySchema = z.object({
  id: z.string(),
  actorType: z.string(),
  actorId: z.string(),
  action: z.string(),
  targetType: z.string(),
  targetId: z.string(),
  metadata: z.record(z.string(), z.unknown()),
  createdAt: z.string(),
});
export type AuditLogEntry = z.infer<typeof AuditLogEntrySchema>;

// --- Pairing sessions (PAIR-002) -----------------------------------------

export const PairingSessionSchema = z.object({
  id: z.string(),
  status: z.enum(['pending', 'completed', 'expired']),
  expiresAt: z.string(),
  deviceId: z.string().nullable(),
});
export type PairingSession = z.infer<typeof PairingSessionSchema>;

// --- Review responses (REV-001) -------------------------------------------

/** Share of fields a record must resolve before it can be approved. */
export const BlockingFieldSchema = z.object({
  path: z.string(),
  reason: z.enum(['low_confidence', 'missing_value', 'not_found', 'not_processed']),
  confidence: z.number(),
});
export type ReviewBlockingField = z.infer<typeof BlockingFieldSchema>;

export const FieldChangeResponseSchema = z.object({
  id: z.string(),
  reviewId: z.string(),
  fieldPath: z.string(),
  originalValue: z.unknown().nullable(),
  correctedValue: z.unknown().nullable(),
  originalConfidence: z.number().nullable(),
  changedBy: z.string(),
  createdAt: z.string(),
});
export type FieldChangeRecord = z.infer<typeof FieldChangeResponseSchema>;

export const ReviewQueueItemSchema = z.object({
  document: z.lazy(() => DocumentSchema),
  extractionId: z.string().nullable(),
  confidence: z.number().nullable(),
  blockingFields: z.array(BlockingFieldSchema),
});
export type ReviewQueueItem = z.infer<typeof ReviewQueueItemSchema>;

export const ReviewQueueResponseSchema = z.object({
  items: z.array(ReviewQueueItemSchema),
  total: z.number().int(),
});
export type ReviewQueueResponse = z.infer<typeof ReviewQueueResponseSchema>;

export const ReviewSessionSchema = z.object({
  reviewId: z.string(),
  status: z.enum(['in_progress', 'approved', 'rejected']),
  document: z.lazy(() => DocumentSchema),
  documentType: z.enum(DOCUMENT_TYPES),
  documentTypeConfidence: z.number(),
  udm: UdmSchema,
  blocking: z.array(BlockingFieldSchema),
  changes: z.array(FieldChangeResponseSchema),
});
export type ReviewSession = z.infer<typeof ReviewSessionSchema>;

export const PatchFieldsResponseSchema = z.object({
  reviewId: z.string(),
  extractionId: z.string(),
  blocking: z.array(BlockingFieldSchema),
  applied: z.number().int(),
  documentType: z.enum(DOCUMENT_TYPES),
});
export type PatchFieldsResponse = z.infer<typeof PatchFieldsResponseSchema>;

export const ApproveResponseSchema = z.object({
  reviewId: z.string(),
  documentId: z.string(),
  status: z.literal('approved'),
});
export type ApproveResponse = z.infer<typeof ApproveResponseSchema>;

export const RejectResponseSchema = z.object({
  reviewId: z.string(),
  status: z.literal('rejected'),
});
export type RejectResponse = z.infer<typeof RejectResponseSchema>;

/** Bulk approve never silently approves an unresolved record: it reports what was skipped. */
export const BulkApproveResponseSchema = z.object({
  approved: z.array(z.string()),
  skipped: z.array(z.object({ documentId: z.string(), blocking: z.array(BlockingFieldSchema) })),
});
export type BulkApproveResponse = z.infer<typeof BulkApproveResponseSchema>;

export const DocumentResultResponseSchema = z.object({
  document: z.lazy(() => DocumentSchema),
  extraction: ExtractionResultSchema.nullable(),
});
export type DocumentResultResponse = z.infer<typeof DocumentResultResponseSchema>;

// --- Document templates (TPL-001) ----------------------------------------

/** Scopes a template field can require the extractor to look for. */
export const TemplateFieldSchema = z
  .object({
    path: z.string().regex(/^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*$/, 'Use a dotted field path'),
    label: z.string().trim().min(1).max(120),
    type: z.enum(['string', 'number', 'currency', 'date', 'boolean']).default('string'),
    required: z.boolean().default(false),
    /** Optional hint shown to reviewers, e.g. where the value normally appears. */
    hint: z.string().max(200).optional(),
  })
  .strict();
export type TemplateField = z.infer<typeof TemplateFieldSchema>;

export const CreateTemplateRequestSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    documentType: z.enum(DOCUMENT_TYPES),
    fields: z.array(TemplateFieldSchema).max(100).default([]),
    /** Optional: seed the field list from an existing document's latest extraction. */
    fromDocumentId: z.string().uuid().optional(),
  })
  .strict();
export type CreateTemplateRequest = z.infer<typeof CreateTemplateRequestSchema>;

export const UpdateTemplateRequestSchema = z
  .object({
    name: z.string().trim().min(1).max(120).optional(),
    documentType: z.enum(DOCUMENT_TYPES).optional(),
    fields: z.array(TemplateFieldSchema).max(100).optional(),
    active: z.boolean().optional(),
  })
  .strict();
export type UpdateTemplateRequest = z.infer<typeof UpdateTemplateRequestSchema>;

export const TemplateSchema = z.object({
  id: z.string(),
  name: z.string(),
  documentType: z.enum(DOCUMENT_TYPES),
  fields: z.array(TemplateFieldSchema),
  version: z.number().int().positive(),
  active: z.boolean(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Template = z.infer<typeof TemplateSchema>;

export const TemplateVersionSchema = z.object({
  version: z.number().int().positive(),
  fields: z.array(TemplateFieldSchema),
  createdAt: z.string(),
  createdBy: z.string().nullable(),
});
export type TemplateVersion = z.infer<typeof TemplateVersionSchema>;

export const TemplateDetailSchema = TemplateSchema.extend({
  versions: z.array(TemplateVersionSchema),
});
export type TemplateDetail = z.infer<typeof TemplateDetailSchema>;

// --- API keys (DEVAPI-001) -----------------------------------------------

/** Scopes map to the narrowest role that already implies them. */
export const API_KEY_SCOPES = [
  'documents:read',
  'documents:write',
  'review:write',
  'exports:read',
  'connectors:write',
  'admin',
] as const;
export type ApiKeyScope = (typeof API_KEY_SCOPES)[number];

export const CreateApiKeyRequestSchema = z
  .object({
    name: z.string().trim().min(1).max(80),
    scopes: z.array(z.enum(API_KEY_SCOPES)).min(1).max(10),
    /** Optional expiry; a key without one lives until revoked. */
    expiresInDays: z.number().int().min(1).max(730).optional(),
  })
  .strict();
export type CreateApiKeyRequest = z.infer<typeof CreateApiKeyRequestSchema>;

export const ApiKeySchema = z.object({
  id: z.string(),
  name: z.string(),
  /** First characters only, so a person can tell keys apart without exposing them. */
  prefix: z.string(),
  scopes: z.array(z.enum(API_KEY_SCOPES)),
  createdAt: z.string(),
  lastUsedAt: z.string().nullable().optional(),
  revokedAt: z.string().nullable().optional(),
});
export type ApiKey = z.infer<typeof ApiKeySchema>;

/** The only response that ever contains the secret: it is shown once and never again. */
export const CreatedApiKeySchema = ApiKeySchema.extend({
  key: z.string(),
  /** Echoed so the UI can warn before the person navigates away. */
  shownOnce: z.literal(true),
});
export type CreatedApiKey = z.infer<typeof CreatedApiKeySchema>;

/** A saved UDM → destination mapping, reused for every send (MAP-001). */
export const MappingProfileSchema = z.object({
  id: z.string(),
  connectorId: z.string().nullable().optional(),
  documentType: z.enum(DOCUMENT_TYPES),
  name: z.string(),
  fieldMap: z.array(MappingFieldSchema),
  duplicatePolicy: z.enum(DUPLICATE_POLICIES),
  duplicateKeys: z.array(z.string()),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type MappingProfile = z.infer<typeof MappingProfileSchema>;

export const OrganisationSchema = z.object({
  id: z.string(),
  name: z.string(),
  slug: z.string(),
  plan: z.string(),
  retentionDays: z.number().int(),
  aiProvider: z.enum(['local', 'cloud']),
  createdAt: z.string(),
});
export type Organisation = z.infer<typeof OrganisationSchema>;

export const TeamMemberSchema = UserSummarySchema.extend({
  acceptedAt: z.string().nullable().optional(),
  lastLoginAt: z.string().nullable().optional(),
  disabledAt: z.string().nullable().optional(),
});
export type TeamMember = z.infer<typeof TeamMemberSchema>;

export const AnalyticsSchema = z.object({
  documents: z.record(z.string(), z.number()),
  reviews: z.record(z.string(), z.number()),
  exports: z.record(z.string(), z.number()),
  connectors: z.number().int(),
  devices: z.number().int(),
});
export type Analytics = z.infer<typeof AnalyticsSchema>;

// --- Batches (BATCH-001) -------------------------------------------------

export const BatchItemSchema = z.object({
  position: z.number().int().min(0),
  filename: z.string().max(255).optional(),
  documentId: z.string().nullable(),
  documentType: z.string().optional(),
  status: z.enum(['queued', 'processing', 'succeeded', 'failed']),
  error: z.string().optional(),
  updatedAt: z.string().optional(),
});
export type BatchItem = z.infer<typeof BatchItemSchema>;

export const BatchSummarySchema = z.object({
  id: z.string(),
  name: z.string(),
  projectId: z.string().optional(),
  total: z.number().int(),
  processed: z.number().int(),
  succeeded: z.number().int(),
  failed: z.number().int(),
  status: z.enum(['processing', 'completed', 'completed_with_errors']),
  items: z.array(BatchItemSchema),
  createdAt: z.string(),
});
export type BatchSummary = z.infer<typeof BatchSummarySchema>;

export const CreateBatchRequestSchema = z
  .object({
    name: z.string().trim().min(1).max(120).optional(),
    projectId: z.string().uuid().optional(),
    documentType: z.enum(DOCUMENT_TYPES).optional(),
  })
  .strict();
export type CreateBatchRequest = z.infer<typeof CreateBatchRequestSchema>;

// --- Projects (TEAM-001) -------------------------------------------------

export const ProjectSchema = z.object({
  id: z.string(),
  name: z.string(),
  key: z.string(),
  archivedAt: z.string().nullable().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Project = z.infer<typeof ProjectSchema>;

export const CreateProjectRequestSchema = z
  .object({
    name: z.string().trim().min(2).max(120),
    key: z.string().trim().max(20).optional(),
  })
  .strict();
export type CreateProjectRequest = z.infer<typeof CreateProjectRequestSchema>;

export const UpdateProjectRequestSchema = z
  .object({
    name: z.string().trim().min(2).max(120).optional(),
    archived: z.boolean().optional(),
  })
  .strict();
export type UpdateProjectRequest = z.infer<typeof UpdateProjectRequestSchema>;

// --- Invitations (TEAM-001) ----------------------------------------------

export const InvitationSchema = z.object({
  id: z.string(),
  email: z.string(),
  role: z.enum(ROLES),
  expiresAt: z.string(),
  usedAt: z.string().nullable().optional(),
  createdAt: z.string(),
});
export type Invitation = z.infer<typeof InvitationSchema>;

/** The token is returned once, because this deployment has no email delivery configured. */
export const CreatedInvitationSchema = InvitationSchema.extend({
  token: z.string(),
  acceptUrl: z.string(),
});
export type CreatedInvitation = z.infer<typeof CreatedInvitationSchema>;

export const AcceptInviteRequestSchema = z
  .object({
    token: z.string().min(20).max(200),
    password: PasswordSchema,
  })
  .strict();
export type AcceptInviteRequest = z.infer<typeof AcceptInviteRequestSchema>;

// --- Dashboard statistics (DASH-001) -------------------------------------

export const StatsTimelinePointSchema = z.object({
  date: z.string(),
  uploaded: z.number().int(),
  approved: z.number().int(),
  failed: z.number().int(),
});
export type StatsTimelinePoint = z.infer<typeof StatsTimelinePointSchema>;

export const StatsResponseSchema = z.object({
  organisationId: z.string(),
  documents: z.record(z.string(), z.number()),
  totalDocuments: z.number().int(),
  jobs: z.record(z.string(), z.number()),
  documentTypes: z.record(z.string(), z.number()),
  timeline: z.array(StatsTimelinePointSchema),
  connectors: z.object({ total: z.number().int(), active: z.number().int() }),
  exports: z.object({ total: z.number().int(), ready: z.number().int() }),
  review: z.object({ pending: z.number().int(), approved: z.number().int() }),
  generatedAt: z.string(),
});
export type StatsResponse = z.infer<typeof StatsResponseSchema>;

export const HealthResponseSchema = z.object({
  status: z.enum(['ok', 'degraded']),
  version: z.string(),
  uptimeSeconds: z.number(),
  dependencies: z.record(z.string(), z.enum(['ok', 'error', 'unavailable'])),
});
export type HealthResponse = z.infer<typeof HealthResponseSchema>;

/** The QR payload format: `idcp://pair?e=<endpoint>&t=<token>`. */
export const PAIRING_QR_SCHEME = 'idcp';
export const PAIRING_QR_HOST = 'pair';

export function buildPairingQrPayload(endpoint: string, token: string): string {
  const params = new URLSearchParams({ e: endpoint, t: token });
  return `${PAIRING_QR_SCHEME}://${PAIRING_QR_HOST}?${params.toString()}`;
}

/** Parse a scanned QR payload. Returns null for anything that is not ours or is malformed. */
export function parsePairingQrPayload(payload: string): { endpoint: string; token: string } | null {
  if (typeof payload !== 'string') return null;
  const trimmed = payload.trim();
  if (!trimmed.startsWith(`${PAIRING_QR_SCHEME}://${PAIRING_QR_HOST}`)) return null;

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }
  const endpoint = url.searchParams.get('e');
  const token = url.searchParams.get('t');
  if (!endpoint || !token) return null;

  let parsedEndpoint: URL;
  try {
    parsedEndpoint = new URL(endpoint);
  } catch {
    return null;
  }
  if (!['https:', 'http:'].includes(parsedEndpoint.protocol)) return null;
  // In production the endpoint must be HTTPS (SECURITY.md §6.1).
  if (parsedEndpoint.protocol === 'http:' && !isLoopbackHost(parsedEndpoint.hostname)) return null;
  if (token.length < 20 || token.length > 200) return null;

  return { endpoint: parsedEndpoint.toString().replace(/\/$/, ''), token };
}

function isLoopbackHost(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1';
}

export { UDM_VERSION };
