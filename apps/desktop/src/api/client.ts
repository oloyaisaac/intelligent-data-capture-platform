import type {
  ApiKey,
  ApproveResponse,
  BulkApproveResponse,
  CompletePairingRequest,
  CompletePairingResponse,
  Connector,
  CreateApiKeyRequest,
  CreateProjectRequest,
  CreateConnectorRequest,
  CreateExportRequest,
  CreateMappingProfileRequest,
  CreatePairingSessionResponse,
  CreateTemplateRequest,
  CorrectionStatsResponse,
  CreatedApiKey,
  Device,
  DuplicateCheckResponse,
  DocumentListResponse,
  DocumentResultResponse,
  DocumentSummary,
  BatchSummary,
  CreatedInvitation,
  ExportRecord,
  Invitation,
  MappingProfile,
  Organisation,
  PatchFieldsResponse,
  Project,
  ReviewQueueResponse,
  ReviewSession,
  StatsResponse,
  Template,
  TemplateDetail,
  TokenPair,
  UpdateProjectRequest,
  UpdateTemplateRequest,
  UserSummary,
} from '@idcp/shared';

/**
 * Renderer API client.
 *
 * The renderer has no Node access (DESK-001), so this is plain `fetch` against relative URLs.
 * Tokens live in the OS keychain through the Electron bridge when it is present, and in memory
 * otherwise (the browser build used for development must not persist secrets to localStorage).
 */

export class ApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export interface TokenStorage {
  read(): Promise<{ accessToken: string | null; refreshToken: string | null }>;
  write(tokens: { accessToken: string | null; refreshToken: string | null }): Promise<void>;
}

export class MemoryTokenStorage implements TokenStorage {
  private tokens = { accessToken: null as string | null, refreshToken: null as string | null };

  async read() {
    return { ...this.tokens };
  }

  async write(tokens: { accessToken: string | null; refreshToken: string | null }) {
    this.tokens = { ...tokens };
  }
}

/** Uses the preload bridge when running inside Electron; the keychain is the only persistence. */
export class BridgeTokenStorage implements TokenStorage {
  constructor(
    private readonly bridge: {
      readTokens(): Promise<{ accessToken: string | null; refreshToken: string | null }>;
      writeTokens(tokens: {
        accessToken: string | null;
        refreshToken: string | null;
      }): Promise<void>;
    },
    private readonly fallback = new MemoryTokenStorage(),
  ) {}

  read() {
    return this.bridge.readTokens().catch(() => this.fallback.read());
  }

  write(tokens: { accessToken: string | null; refreshToken: string | null }) {
    return this.bridge.writeTokens(tokens).catch(() => this.fallback.write(tokens));
  }
}

export interface ApiClientOptions {
  /** Defaults to the same origin; the Vite dev server proxies /api to the backend. */
  baseUrl?: string;
  storage?: TokenStorage;
  fetchImpl?: typeof fetch;
  onSessionExpired?: () => void;
}

type Method = 'GET' | 'POST' | 'PATCH' | 'DELETE';

/** Files chosen in the renderer; each becomes its own document on the server. */
export interface CreateBatchInput {
  files: File[];
  name?: string;
  projectId?: string;
  documentType?: string;
}

interface RequestOptions {
  method?: Method;
  body?: unknown;
  anonymous?: boolean;
  rawResponse?: boolean;
  retry?: boolean;
  headers?: Record<string, string>;
}

export class ApiClient {
  private readonly baseUrl: string;
  private readonly storage: TokenStorage;
  private readonly fetchImpl: typeof fetch;
  private accessToken: string | null = null;

  constructor(private readonly options: ApiClientOptions = {}) {
    this.baseUrl = (options.baseUrl ?? '/api/v1').replace(/\/$/, '');
    this.storage = options.storage ?? new MemoryTokenStorage();
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  /** The in-memory access token. Used to open the event stream; never persisted in the renderer. */
  currentAccessToken(): string | null {
    return this.accessToken;
  }

  async restoreSession(): Promise<boolean> {
    const { accessToken, refreshToken } = await this.storage.read();
    if (!refreshToken) return false;
    this.accessToken = accessToken;
    if (accessToken) return true;
    return (await this.refresh()) !== null;
  }

  private async send(path: string, options: RequestOptions): Promise<Response> {
    const headers: Record<string, string> = { accept: 'application/json', ...options.headers };
    if (!options.anonymous && this.accessToken)
      headers.authorization = `Bearer ${this.accessToken}`;

    let body: string | undefined;
    if (options.body !== undefined) {
      headers['content-type'] = 'application/json';
      body = JSON.stringify(options.body);
    }

    return this.fetchImpl(`${this.baseUrl}${path}`, {
      method: options.method ?? 'GET',
      headers,
      body,
      credentials: 'include',
    });
  }

  /**
   * Multipart requests cannot go through `send`: the browser sets the boundary itself, so the
   * `content-type` header must be left alone.
   */
  private async sendForm(path: string, form: FormData): Promise<Response> {
    const headers: Record<string, string> = { accept: 'application/json' };
    if (this.accessToken) headers.authorization = `Bearer ${this.accessToken}`;
    return this.fetchImpl(`${this.baseUrl}${path}`, {
      method: 'POST',
      headers,
      body: form,
      credentials: 'include',
    });
  }

  private async toError(response: Response): Promise<ApiError> {
    let code = 'INTERNAL_ERROR';
    let message = 'Something went wrong. Please try again.';
    let details: unknown;
    try {
      const envelope = (await response.json()) as {
        error?: { code?: string; message?: string; details?: unknown };
      };
      code = envelope.error?.code ?? code;
      message = envelope.error?.message ?? message;
      details = envelope.error?.details;
    } catch {
      // A non-JSON error body is never shown verbatim.
    }
    return new ApiError(code, message, response.status, details);
  }

  async request<T>(path: string, options: RequestOptions = {}): Promise<T> {
    let response = await this.send(path, options);

    if (response.status === 401 && !options.anonymous && options.retry !== false) {
      const token = await this.refresh();
      if (token) {
        response = await this.send(path, { ...options, retry: false });
      } else {
        this.options.onSessionExpired?.();
        throw new ApiError('UNAUTHENTICATED', 'Your session has expired. Sign in again.', 401);
      }
    }

    if (!response.ok) throw await this.toError(response);
    if (response.status === 204) return undefined as T;
    const text = await response.text();
    return (text ? JSON.parse(text) : undefined) as T;
  }

  async refresh(): Promise<string | null> {
    const { refreshToken } = await this.storage.read();
    if (!refreshToken) return null;

    const response = await this.send('/auth/refresh', {
      method: 'POST',
      body: { refreshToken },
      anonymous: true,
    });
    if (!response.ok) {
      await this.clearSession();
      return null;
    }
    const pair = (await response.json()) as TokenPair;
    this.accessToken = pair.accessToken;
    await this.storage.write({ accessToken: pair.accessToken, refreshToken: pair.refreshToken });
    return pair.accessToken;
  }

  private async clearSession(): Promise<void> {
    this.accessToken = null;
    await this.storage.write({ accessToken: null, refreshToken: null });
  }

  /** Downloads a file through the authenticated client (never a bare link). */
  async download(path: string): Promise<{ blob: Blob; filename: string }> {
    const response = await this.send(path, { method: 'GET' });
    if (!response.ok) throw await this.toError(response);
    const disposition = response.headers.get('content-disposition') ?? '';
    const match = /filename="?([^";]+)"?/.exec(disposition);
    return { blob: await response.blob(), filename: match?.[1] ?? 'export' };
  }

  // --- Auth ---------------------------------------------------------------

  async login(input: { email: string; password: string }): Promise<UserSummary> {
    const pair = await this.request<TokenPair>('/auth/login', {
      method: 'POST',
      body: input,
      anonymous: true,
    });
    this.accessToken = pair.accessToken;
    await this.storage.write({ accessToken: pair.accessToken, refreshToken: pair.refreshToken });
    return pair.user;
  }

  /** Stores a token pair obtained outside `login` (accepting an invitation). */
  async adoptSession(pair: TokenPair): Promise<UserSummary> {
    this.accessToken = pair.accessToken;
    await this.storage.write({ accessToken: pair.accessToken, refreshToken: pair.refreshToken });
    return pair.user;
  }

  async register(input: {
    email: string;
    password: string;
    displayName: string;
    organisationName: string;
  }): Promise<UserSummary> {
    const pair = await this.request<TokenPair>('/auth/register', {
      method: 'POST',
      body: input,
      anonymous: true,
    });
    this.accessToken = pair.accessToken;
    await this.storage.write({ accessToken: pair.accessToken, refreshToken: pair.refreshToken });
    return pair.user;
  }

  async logout(): Promise<void> {
    const { refreshToken } = await this.storage.read();
    if (refreshToken) {
      await this.request('/auth/logout', {
        method: 'POST',
        body: { refreshToken },
        anonymous: true,
      }).catch(() => undefined);
    }
    await this.clearSession();
  }

  me(): Promise<UserSummary> {
    return this.request<UserSummary>('/auth/me');
  }

  // --- Pairing ------------------------------------------------------------

  createPairingSession(): Promise<CreatePairingSessionResponse> {
    return this.request('/pairing/sessions', { method: 'POST', body: {} });
  }

  /** Used by tests and by the mobile simulator; the phone sends this, not the desktop. */
  completePairing(input: CompletePairingRequest): Promise<CompletePairingResponse> {
    return this.request('/pairing/complete', { method: 'POST', body: input, anonymous: true });
  }

  // --- Marketplace (MARKET-001) --------------------------------------------

  listMarketplace(): Promise<{ items: MarketplacePackageSummary[] }> {
    return this.request('/marketplace');
  }

  installPackage(input: {
    packageId: string;
    connectorId: string;
    version?: string;
  }): Promise<MarketplaceInstall> {
    return this.request('/marketplace/install', { method: 'POST', body: input });
  }

  rollbackPackage(installId: string): Promise<{
    rolledBack: string;
    activeVersion: string | null;
    message: string;
  }> {
    return this.request(`/marketplace/installs/${installId}/rollback`, { method: 'POST' });
  }

  listDevices(): Promise<{ items: Device[] }> {
    return this.request('/devices');
  }

  revokeDevice(id: string): Promise<void> {
    return this.request(`/devices/${id}`, { method: 'DELETE' });
  }

  // --- Documents ----------------------------------------------------------

  uploadDocument(file: File, documentType?: string): Promise<{ document: DocumentSummary }> {
    const form = new FormData();
    form.append('file', file);
    if (documentType) form.append('documentType', documentType);
    const headers: Record<string, string> = { 'idempotency-key': `desktop-${crypto.randomUUID()}` };

    return this.fetchImpl(`${this.baseUrl}/documents`, {
      method: 'POST',
      headers: {
        ...headers,
        ...(this.accessToken ? { authorization: `Bearer ${this.accessToken}` } : {}),
      },
      body: form,
      credentials: 'include',
    }).then(async (response) => {
      if (!response.ok) throw await this.toError(response);
      return (await response.json()) as { document: DocumentSummary };
    });
  }

  listDocuments(
    query: {
      status?: string;
      documentType?: string;
      from?: string;
      to?: string;
      limit?: number;
      cursor?: string;
    } = {},
  ): Promise<DocumentListResponse> {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined && value !== '') params.set(key, String(value));
    }
    const suffix = params.toString() ? `?${params.toString()}` : '';
    return this.request(`/documents${suffix}`);
  }

  getDocument(id: string): Promise<DocumentSummary> {
    return this.request(`/documents/${id}`);
  }

  getResult(id: string): Promise<DocumentResultResponse> {
    return this.request(`/documents/${id}/result`);
  }

  reprocess(id: string): Promise<{ jobId: string }> {
    return this.request(`/documents/${id}/reprocess`, { method: 'POST', body: {} });
  }

  deleteDocument(id: string): Promise<void> {
    return this.request(`/documents/${id}`, { method: 'DELETE' });
  }

  // --- Review -------------------------------------------------------------

  reviewQueue(limit = 25): Promise<ReviewQueueResponse> {
    return this.request(`/review/queue?limit=${limit}`);
  }

  openReview(documentId: string): Promise<ReviewSession> {
    return this.request(`/documents/${documentId}/review`, { method: 'POST', body: {} });
  }

  patchFields(
    reviewId: string,
    changes: Array<{ fieldPath: string; value: string | number | boolean | null }>,
    documentType?: string,
  ): Promise<PatchFieldsResponse> {
    return this.request(`/review/${reviewId}/fields`, {
      method: 'PATCH',
      body: { changes, ...(documentType ? { documentType } : {}) },
    });
  }

  approveReview(reviewId: string, notes?: string): Promise<ApproveResponse> {
    return this.request(`/review/${reviewId}/approve`, {
      method: 'POST',
      body: notes ? { notes } : {},
    });
  }

  rejectReview(reviewId: string, reason: string): Promise<{ status: string }> {
    return this.request(`/review/${reviewId}/reject`, { method: 'POST', body: { reason } });
  }

  bulkApprove(documentIds: string[]): Promise<BulkApproveResponse> {
    return this.request('/review/bulk-approve', { method: 'POST', body: { documentIds } });
  }

  // --- Exports ------------------------------------------------------------

  createExport(input: CreateExportRequest): Promise<ExportRecord> {
    return this.request('/exports', { method: 'POST', body: input });
  }

  listExports(): Promise<{ items: ExportRecord[] }> {
    return this.request('/exports');
  }

  downloadExport(id: string): Promise<{ blob: Blob; filename: string }> {
    return this.download(`/exports/${id}/download`);
  }

  // --- Templates ----------------------------------------------------------

  listTemplates(documentType?: string): Promise<{ items: Template[] }> {
    const suffix = documentType ? `?documentType=${documentType}` : '';
    return this.request(`/templates${suffix}`);
  }

  getTemplate(id: string): Promise<TemplateDetail> {
    return this.request(`/templates/${id}`);
  }

  createTemplate(input: CreateTemplateRequest): Promise<TemplateDetail> {
    return this.request('/templates', { method: 'POST', body: input });
  }

  updateTemplate(id: string, input: UpdateTemplateRequest): Promise<TemplateDetail> {
    return this.request(`/templates/${id}`, { method: 'PATCH', body: input });
  }

  disableTemplate(id: string): Promise<void> {
    return this.request(`/templates/${id}`, { method: 'DELETE' });
  }

  // --- Connectors & mapping ----------------------------------------------

  listConnectors(): Promise<{ items: Connector[] }> {
    return this.request('/connectors');
  }

  connectorTypes(): Promise<{
    items: Array<{ type: string; label: string; capabilities: string[] }>;
  }> {
    return this.request('/connectors/types');
  }

  createConnector(input: CreateConnectorRequest): Promise<Connector> {
    return this.request('/connectors', { method: 'POST', body: input });
  }

  testConnector(id: string): Promise<{ ok: boolean; message?: string }> {
    return this.request(`/connectors/${id}/test`, { method: 'POST', body: {} });
  }

  deleteConnector(id: string): Promise<void> {
    return this.request(`/connectors/${id}`, { method: 'DELETE' });
  }

  listMappingProfiles(): Promise<{ items: MappingProfile[] }> {
    return this.request('/mapping-profiles');
  }

  createMappingProfile(input: CreateMappingProfileRequest): Promise<MappingProfile> {
    return this.request('/mapping-profiles', { method: 'POST', body: input });
  }

  deleteMappingProfile(id: string): Promise<void> {
    return this.request(`/mapping-profiles/${id}`, { method: 'DELETE' });
  }

  /** DUP-001: what would happen if this record were sent, and why (read-only). */
  checkDuplicates(
    documentId: string,
    query: { connectorId: string; mappingProfileId: string },
  ): Promise<DuplicateCheckResponse> {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined && value !== '') params.set(key, String(value));
    }
    return this.request(`/documents/${documentId}/duplicates?${params.toString()}`);
  }

  sendDocument(
    documentId: string,
    input: { connectorId: string; mappingProfileId: string },
  ): Promise<{
    status: string;
    created: number;
    updated: number;
    skipped: number;
    summary: string;
  }> {
    return this.request(`/documents/${documentId}/send`, { method: 'POST', body: input });
  }

  /** REV-002: aggregates of what reviewers keep correcting, with the opt-in state. */
  correctionStats(): Promise<CorrectionStatsResponse> {
    return this.request('/review/corrections');
  }

  /** REV-002: admin-only, and refused unless the organisation opted in. */
  exportCorrections(limit = 500): Promise<{
    organisationId: string;
    exportedAt: string;
    rows: Array<{
      documentType: string | null;
      fieldPath: string;
      originalValue: string | null;
      correctedValue: string | null;
      originalConfidence: number | null;
      createdAt: string;
    }>;
  }> {
    return this.request('/review/corrections/export', { method: 'POST', body: { limit } });
  }

  // --- Organisation -------------------------------------------------------

  organisation(): Promise<Organisation> {
    return this.request('/organisation');
  }

  updateOrganisation(input: {
    name?: string;
    retentionDays?: number;
    aiProvider?: 'local' | 'cloud';
    learningOptIn?: boolean;
  }): Promise<Organisation> {
    return this.request('/organisation', { method: 'PATCH', body: input });
  }

  listUsers(): Promise<{
    items: Array<UserSummary & { acceptedAt?: string | null; createdAt?: string }>;
  }> {
    return this.request('/users');
  }

  changeRole(userId: string, role: string): Promise<unknown> {
    return this.request(`/users/${userId}/role`, { method: 'PATCH', body: { role } });
  }

  removeUser(userId: string): Promise<void> {
    return this.request(`/users/${userId}`, { method: 'DELETE' });
  }

  auditLogs(
    query: { actor?: string; action?: string; from?: string; to?: string; limit?: number } = {},
  ): Promise<{
    items: Array<{
      id: string;
      action: string;
      actorType: string;
      actorId: string | null;
      targetType: string | null;
      targetId: string | null;
      createdAt: string;
      metadata?: Record<string, unknown>;
    }>;
  }> {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined && value !== '') params.set(key, String(value));
    }
    const suffix = params.toString() ? `?${params.toString()}` : '';
    return this.request(`/audit-logs${suffix}`);
  }

  stats(days = 14): Promise<StatsResponse> {
    return this.request(`/stats?days=${days}`);
  }

  downloadStatsCsv(days = 14): Promise<{ blob: Blob; filename: string }> {
    return this.download(`/stats.csv?days=${days}`);
  }

  purgeRetention(): Promise<{ purged: number }> {
    return this.request('/retention/purge', { method: 'POST', body: {} });
  }

  // --- Batches (BATCH-001) ------------------------------------------------

  /** One request for many files; per-file failures come back as failed items, not an error. */
  async createBatch(input: CreateBatchInput): Promise<BatchSummary> {
    const form = new FormData();
    if (input.name) form.append('name', input.name);
    if (input.projectId) form.append('projectId', input.projectId);
    if (input.documentType) form.append('documentType', input.documentType);
    for (const file of input.files) form.append('files', file, file.name);

    const response = await this.sendForm('/batches', form);
    if (!response.ok) throw await this.toError(response);
    return (await response.json()) as BatchSummary;
  }

  listBatches(limit = 25): Promise<{ items: BatchSummary[] }> {
    return this.request(`/batches?limit=${limit}`);
  }

  getBatch(id: string): Promise<BatchSummary> {
    return this.request(`/batches/${id}`);
  }

  downloadBatchResults(id: string): Promise<{ blob: Blob; filename: string }> {
    return this.download(`/batches/${id}/results.csv`);
  }

  // --- Projects and invitations (TEAM-001) --------------------------------

  listProjects(includeArchived = false): Promise<{ items: Project[] }> {
    return this.request(`/projects${includeArchived ? '?includeArchived=true' : ''}`);
  }

  createProject(input: CreateProjectRequest): Promise<Project> {
    return this.request('/projects', { method: 'POST', body: input });
  }

  updateProject(id: string, patch: UpdateProjectRequest): Promise<Project> {
    return this.request(`/projects/${id}`, { method: 'PATCH', body: patch });
  }

  archiveProject(id: string): Promise<void> {
    return this.request(`/projects/${id}`, { method: 'DELETE' });
  }

  listInvitations(): Promise<{ items: Invitation[] }> {
    return this.request('/invitations');
  }

  inviteUser(input: {
    email: string;
    role: string;
  }): Promise<{ status: string; invitation: CreatedInvitation }> {
    return this.request('/users/invite', { method: 'POST', body: input });
  }

  revokeInvitation(id: string): Promise<void> {
    return this.request(`/invitations/${id}`, { method: 'DELETE' });
  }

  /** Used by the accept-invite screen; the token in the URL is the credential. */
  acceptInvitation(input: { token: string; password: string }): Promise<TokenPair> {
    return this.request(`/invitations/${encodeURIComponent(input.token)}/accept`, {
      method: 'POST',
      body: { password: input.password },
      anonymous: true,
    });
  }

  // --- API keys -----------------------------------------------------------

  listApiKeys(): Promise<{ items: ApiKey[] }> {
    return this.request('/api-keys');
  }

  createApiKey(input: CreateApiKeyRequest): Promise<CreatedApiKey> {
    return this.request('/api-keys', { method: 'POST', body: input });
  }

  revokeApiKey(id: string): Promise<ApiKey> {
    return this.request(`/api-keys/${id}`, { method: 'DELETE' });
  }
}

/** MARKET-001 — a catalogue entry as the API reports it, including this organisation's state. */
export interface MarketplacePackageSummary {
  id: string;
  type: string;
  label: string;
  vendor: string;
  version: string;
  summary: string;
  permissions: string[];
  status: 'verified' | 'revoked';
  revokedReason?: string;
  signature: string | null;
  signatureVerified: boolean;
  installedVersions: string[];
  availableVersions: string[];
  activeInstallId: string | null;
  installable: boolean;
  blocker: string | null;
  availableConnectors: Array<{ id: string; name: string }>;
}

export interface MarketplaceInstall {
  id: string;
  packageId: string;
  version: string;
  connectorId: string;
  permissions: string[];
  installedAt: string;
  status: string;
}
