import type {
  DocumentStatus,
  DocumentType,
  DuplicatePolicy,
  ReviewStatus,
  Role,
} from '@idcp/shared';

export interface OrganisationRow {
  id: string;
  name: string;
  slug: string;
  plan: string;
  retention_days: number;
  ai_provider: string;
  /** REV-002: corrections may only feed extraction improvements when this is 1. */
  learning_opt_in: number;
  settings: string;
  created_at: string;
  updated_at: string;
}

export interface UserRow {
  id: string;
  email: string;
  password_hash: string | null;
  display_name: string;
  locale: string;
  email_verified_at: string | null;
  last_login_at: string | null;
  disabled_at: string | null;
  /** When this account accepted the legal pack, and which version of it (DEC-032). */
  terms_accepted_at: string | null;
  terms_version: string | null;
  /** TOTP secret, AES-256-GCM encrypted; null until MFA is enrolled (DEC-034). */
  mfa_secret_enc: string | null;
  mfa_enabled_at: string | null;
  /** JSON array of SHA-256 hashes of unused recovery codes. */
  mfa_recovery_hashes: string | null;
  created_at: string;
  updated_at: string;
}

export interface MembershipRow {
  id: string;
  organisation_id: string;
  user_id: string;
  role: Role;
  invited_by: string | null;
  accepted_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface SessionRow {
  id: string;
  user_id: string;
  organisation_id: string;
  refresh_token_hash: string;
  user_agent: string | null;
  ip_hash: string | null;
  expires_at: string;
  revoked_at: string | null;
  created_at: string;
}

export interface PasswordResetRow {
  id: string;
  user_id: string;
  token_hash: string;
  expires_at: string;
  used_at: string | null;
  created_at: string;
}

export interface DeviceRow {
  id: string;
  organisation_id: string;
  user_id: string;
  name: string;
  platform: 'android' | 'ios' | 'desktop';
  app_version: string | null;
  credential_hash: string;
  last_seen_at: string | null;
  revoked_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface PairingSessionRow {
  id: string;
  organisation_id: string;
  created_by: string;
  token_hash: string;
  status: 'pending' | 'completed' | 'expired' | 'cancelled';
  device_id: string | null;
  expires_at: string;
  completed_at: string | null;
  created_at: string;
}

export interface DocumentRow {
  id: string;
  organisation_id: string;
  uploaded_by: string | null;
  device_id: string | null;
  idempotency_key: string | null;
  storage_key: string;
  mime_type: string;
  size_bytes: number;
  sha256: string;
  page_count: number;
  document_type: DocumentType;
  status: DocumentStatus;
  template_id: string | null;
  project_id: string | null;
  deleted_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface DocumentPageRow {
  id: string;
  document_id: string;
  page_number: number;
  storage_key: string;
  width: number | null;
  height: number | null;
  ocr_text: string | null;
  ocr_words: string;
  created_at: string;
}

export interface ExtractionRow {
  id: string;
  document_id: string;
  organisation_id: string;
  attempt: number;
  udm: string;
  udm_version: string;
  provider: string;
  model_version: string | null;
  confidence: number;
  needs_review: number;
  latency_ms: number | null;
  cost_micros: number;
  created_at: string;
}

export interface ReviewRow {
  id: string;
  organisation_id: string;
  document_id: string;
  extraction_id: string;
  reviewer_id: string;
  status: ReviewStatus;
  approved_udm: string | null;
  notes: string | null;
  completed_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface ReviewChangeRow {
  id: string;
  review_id: string;
  field_path: string;
  /** REV-002: the document type at the time of the correction. */
  document_type: string | null;
  original_value: string | null;
  corrected_value: string | null;
  original_confidence: number | null;
  changed_by: string;
  created_at: string;
}

export interface ConnectorRow {
  id: string;
  organisation_id: string;
  type: string;
  name: string;
  config: string;
  credentials_encrypted: string | null;
  status: 'active' | 'disabled' | 'error';
  last_health_check_at: string | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
}

export interface MappingProfileRow {
  id: string;
  organisation_id: string;
  connector_id: string | null;
  document_type: DocumentType;
  name: string;
  field_map: string;
  duplicate_policy: DuplicatePolicy;
  duplicate_keys: string;
  created_at: string;
  updated_at: string;
}

export interface ConnectorRunRow {
  id: string;
  organisation_id: string;
  connector_id: string;
  mapping_profile_id: string | null;
  document_id: string | null;
  operation: string;
  status: 'queued' | 'running' | 'succeeded' | 'failed' | 'skipped_duplicate';
  request_summary: string | null;
  response_summary: string | null;
  error: string | null;
  duration_ms: number | null;
  created_at: string;
}

export interface ExportRow {
  id: string;
  organisation_id: string;
  requested_by: string;
  format: 'xlsx' | 'csv';
  filter: string;
  row_count: number | null;
  storage_key: string | null;
  status: 'queued' | 'ready' | 'failed' | 'expired';
  expires_at: string | null;
  created_at: string;
}

export interface JobRow {
  id: string;
  organisation_id: string;
  type: string;
  document_id: string | null;
  payload: string;
  status: 'queued' | 'running' | 'succeeded' | 'failed' | 'dead';
  attempts: number;
  max_attempts: number;
  last_error: string | null;
  run_after: string | null;
  started_at: string | null;
  finished_at: string | null;
  created_at: string;
}

export interface AuditLogRow {
  id: string;
  organisation_id: string;
  actor_type: string;
  actor_id: string | null;
  action: string;
  target_type: string | null;
  target_id: string | null;
  ip_hash: string | null;
  metadata: string;
  created_at: string;
}

export interface TemplateRow {
  id: string;
  organisation_id: string;
  name: string;
  document_type: string;
  fields: string;
  sample_storage_key: string | null;
  version: number;
  active: number;
  created_at: string;
  updated_at: string;
}

export interface TemplateVersionRow {
  id: string;
  template_id: string;
  organisation_id: string;
  version: number;
  fields: string;
  created_by: string | null;
  created_at: string;
}

export interface ApiKeyRow {
  id: string;
  organisation_id: string;
  name: string;
  key_hash: string;
  key_prefix: string;
  scopes: string;
  created_by: string;
  last_used_at: string | null;
  revoked_at: string | null;
  created_at: string;
}

export interface BatchRow {
  id: string;
  organisation_id: string;
  name: string;
  project_id: string | null;
  created_by: string;
  created_at: string;
}

export interface BatchItemRow {
  id: string;
  batch_id: string;
  document_id: string | null;
  position: number;
  filename: string | null;
  error: string | null;
  created_at: string;
}

export interface ProjectRow {
  id: string;
  organisation_id: string;
  name: string;
  key: string;
  created_by: string;
  archived_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface InvitationRow {
  id: string;
  organisation_id: string;
  user_id: string;
  email: string;
  role: string;
  token_hash: string;
  invited_by: string;
  expires_at: string;
  used_at: string | null;
  created_at: string;
}
