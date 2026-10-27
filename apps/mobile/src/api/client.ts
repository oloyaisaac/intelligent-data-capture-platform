import {
  type CompletePairingRequest,
  type CompletePairingResponse,
  type CreatePairingSessionResponse,
  type DocumentListResponse,
  type DocumentResultResponse,
  type DocumentUploadResponse,
  type ExportRecord,
  type LoginResponse,
  type PatchFieldsResponse,
  type ReviewQueueResponse,
  type ReviewSession,
  type TokenPair,
  type UserSummary,
  type Device,
  type ApproveResponse,
  type BulkApproveResponse,
} from '@idcp/shared';

/**
 * Mobile API client.
 *
 * Responsibilities kept here (and testable without a device):
 *  - attach the session token, or the paired-device credential for uploads
 *  - retry exactly once on 401 by refreshing, and store the rotated refresh token
 *  - turn error envelopes into typed errors with a message safe to show a person
 *  - refuse to talk to a non-HTTPS endpoint outside development
 */

/**
 * The password was right but a second factor is required (DEC-034). `login` has already stashed the
 * challenge token, so the screen only has to ask for the code and call `completeMfa`.
 */
export class MfaRequiredError extends Error {
  constructor() {
    super('Enter the code from your authenticator app.');
    this.name = 'MfaRequiredError';
  }
}

export class ApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export interface TokenStore {
  getAccessToken(): Promise<string | null>;
  getRefreshToken(): Promise<string | null>;
  saveTokens(tokens: { accessToken: string; refreshToken: string }): Promise<void>;
  clear(): Promise<void>;
  getDeviceCredential(): Promise<string | null>;
  saveDeviceCredential(credential: string): Promise<void>;
}

export interface ApiClientOptions {
  baseUrl: string;
  store: TokenStore;
  fetchImpl?: typeof fetch;
  /** Called when the session cannot be refreshed, so the UI can return to sign-in. */
  onSessionExpired?: () => void;
}

interface RequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  body?: unknown;
  /** Send the paired-device credential instead of a user session. */
  device?: boolean;
  /** Skip auth entirely (login/register/pairing). */
  anonymous?: boolean;
  retryOnUnauthorized?: boolean;
  /** Extra headers, e.g. an Idempotency-Key on multipart uploads. */
  headers?: Record<string, string>;
  /** Override the base URL for a single call — used by pairing, before an endpoint is known. */
  endpoint?: string;
}

const LOOPBACK = /^http:\/\/(localhost|127\.0\.0\.1|10\.0\.2\.2)(:\d+)?(\/|$)/;

export function assertSecureEndpoint(endpoint: string): string {
  const normalised = endpoint.replace(/\/$/, '');
  if (!/^https:\/\//.test(normalised) && !LOOPBACK.test(normalised)) {
    throw new Error('The server address must start with https://.');
  }
  return normalised;
}

export class ApiClient {
  private readonly store: TokenStore;
  private readonly fetchImpl: typeof fetch;
  private baseUrl: string;

  constructor(private readonly options: ApiClientOptions) {
    this.baseUrl = assertSecureEndpoint(options.baseUrl);
    this.store = options.store;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  /** The server address learned from a pairing code becomes the session endpoint. */
  setEndpoint(endpoint: string): void {
    this.baseUrl = assertSecureEndpoint(endpoint);
  }

  getEndpoint(): string {
    return this.baseUrl;
  }

  private async raw(
    path: string,
    options: RequestOptions,
    token: string | null,
  ): Promise<Response> {
    const headers: Record<string, string> = { accept: 'application/json', ...options.headers };
    if (token) {
      if (options.device) headers['x-device-credential'] = token;
      else headers.authorization = `Bearer ${token}`;
    }

    let body: string | FormData | undefined;
    if (typeof FormData !== 'undefined' && options.body instanceof FormData) {
      body = options.body;
    } else if (options.body !== undefined) {
      headers['content-type'] = 'application/json';
      body = JSON.stringify(options.body);
    }

    const base = options.endpoint ? assertSecureEndpoint(options.endpoint) : this.baseUrl;
    return this.fetchImpl(`${base}${path}`, { method: options.method ?? 'GET', headers, body });
  }

  private async parse<T>(response: Response): Promise<T> {
    if (response.status === 204) return undefined as T;
    const text = await response.text();
    if (!response.ok) {
      let code = 'INTERNAL_ERROR';
      let message = 'Something went wrong. Please try again.';
      try {
        const envelope = JSON.parse(text) as { error?: { code?: string; message?: string } };
        code = envelope.error?.code ?? code;
        message = envelope.error?.message ?? message;
      } catch {
        // A non-JSON body is never shown to the user verbatim.
      }
      throw new ApiError(code, message, response.status);
    }
    return (text ? JSON.parse(text) : undefined) as T;
  }

  async request<T>(path: string, options: RequestOptions = {}): Promise<T> {
    const token = options.anonymous
      ? null
      : options.device
        ? await this.store.getDeviceCredential()
        : await this.store.getAccessToken();

    const response = await this.raw(path, options, token ?? null);

    if (
      response.status === 401 &&
      !options.anonymous &&
      !options.device &&
      options.retryOnUnauthorized !== false
    ) {
      const refreshed = await this.refresh();
      if (refreshed) return this.parse<T>(await this.raw(path, options, refreshed));
      this.options.onSessionExpired?.();
      throw new ApiError('UNAUTHENTICATED', 'Your session has expired. Sign in again.', 401);
    }

    return this.parse<T>(response);
  }

  /** Exchanges the refresh token for a new pair. Returns the new access token, or null. */
  async refresh(): Promise<string | null> {
    const refreshToken = await this.store.getRefreshToken();
    if (!refreshToken) return null;

    const response = await this.raw(
      '/auth/refresh',
      { method: 'POST', body: { refreshToken } },
      null,
    );
    if (!response.ok) {
      await this.store.clear();
      return null;
    }
    const tokens = (await response.json()) as TokenPair;
    await this.store.saveTokens({
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
    });
    return tokens.accessToken;
  }

  // --- Auth ---------------------------------------------------------------

  async register(input: {
    email: string;
    password: string;
    displayName: string;
    organisationName: string;
  }): Promise<TokenPair> {
    const tokens = await this.request<TokenPair>('/auth/register', {
      method: 'POST',
      body: input,
      anonymous: true,
    });
    await this.store.saveTokens(tokens);
    return tokens;
  }

  private pendingChallenge: string | null = null;

  /** Either a session, or an `MfaRequiredError` carrying the pending challenge (DEC-034). */
  async login(input: { email: string; password: string }): Promise<TokenPair> {
    const result = await this.request<LoginResponse>('/auth/login', {
      method: 'POST',
      body: input,
      anonymous: true,
    });
    if ('mfaRequired' in result) {
      this.pendingChallenge = result.challengeToken;
      throw new MfaRequiredError();
    }
    await this.store.saveTokens(result);
    return result;
  }

  /** Second half of sign-in: the challenge token from `login`, plus a code or recovery code. */
  async completeMfa(code: string): Promise<TokenPair> {
    const challengeToken = this.pendingChallenge;
    if (!challengeToken) throw new ApiError('UNAUTHENTICATED', 'Start signing in again.', 401);
    const pair = await this.request<TokenPair>('/auth/mfa/verify', {
      method: 'POST',
      body: { challengeToken, code },
      anonymous: true,
    });
    this.pendingChallenge = null;
    await this.store.saveTokens(pair);
    return pair;
  }

  /** Revokes the refresh token server-side, then clears local state. */
  async logout(): Promise<void> {
    const refreshToken = await this.store.getRefreshToken();
    if (refreshToken) {
      await this.request('/auth/logout', {
        method: 'POST',
        body: { refreshToken },
        anonymous: true,
      }).catch(() => undefined);
    }
    this.pendingChallenge = null;
    await this.store.clear();
  }

  me(): Promise<UserSummary> {
    return this.request<UserSummary>('/auth/me');
  }

  // --- Pairing ------------------------------------------------------------

  /** The phone posts the scanned token to the endpoint carried by the code itself. */
  completePairing(
    input: CompletePairingRequest,
    endpoint?: string,
  ): Promise<CompletePairingResponse> {
    return this.request<CompletePairingResponse>('/pairing/complete', {
      method: 'POST',
      body: input,
      anonymous: true,
      endpoint,
    });
  }

  /** The desktop app creates pairing sessions; exposed here so the flow is testable end to end. */
  createPairingSession(): Promise<CreatePairingSessionResponse> {
    return this.request<CreatePairingSessionResponse>('/pairing/sessions', { method: 'POST' });
  }

  listDevices(): Promise<{ items: Device[] }> {
    return this.request('/devices');
  }

  revokeDevice(deviceId: string): Promise<void> {
    return this.request(`/devices/${deviceId}`, { method: 'DELETE' });
  }

  // --- Documents ----------------------------------------------------------

  /** Uploads one captured page with an idempotency key so a retry never duplicates it. */
  uploadDocument(input: {
    uri: string;
    fileName: string;
    mimeType: string;
    idempotencyKey: string;
  }): Promise<DocumentUploadResponse> {
    const form = new FormData();
    form.append('file', {
      uri: input.uri,
      name: input.fileName,
      type: input.mimeType,
    } as unknown as Blob);

    return this.request<DocumentUploadResponse>('/documents', {
      method: 'POST',
      body: form,
      device: true,
      headers: { 'idempotency-key': input.idempotencyKey },
    });
  }

  listDocuments(
    query: { status?: string; limit?: number; cursor?: string } = {},
  ): Promise<DocumentListResponse> {
    const params = new URLSearchParams();
    if (query.status) params.set('status', query.status);
    if (query.limit) params.set('limit', String(query.limit));
    if (query.cursor) params.set('cursor', query.cursor);
    const suffix = params.toString() ? `?${params.toString()}` : '';
    return this.request<DocumentListResponse>(`/documents${suffix}`);
  }

  getResult(documentId: string): Promise<DocumentResultResponse> {
    return this.request<DocumentResultResponse>(`/documents/${documentId}/result`);
  }

  reprocess(documentId: string): Promise<{ jobId: string }> {
    return this.request(`/documents/${documentId}/reprocess`, { method: 'POST', body: {} });
  }

  // --- Review -------------------------------------------------------------

  reviewQueue(limit = 25): Promise<ReviewQueueResponse> {
    return this.request<ReviewQueueResponse>(`/review/queue?limit=${limit}`);
  }

  openReview(documentId: string): Promise<ReviewSession> {
    return this.request<ReviewSession>(`/documents/${documentId}/review`, {
      method: 'POST',
      body: {},
    });
  }

  patchFields(
    reviewId: string,
    changes: Array<{ fieldPath: string; value: string | number | boolean | null }>,
    documentType?: string,
  ): Promise<PatchFieldsResponse> {
    return this.request<PatchFieldsResponse>(`/review/${reviewId}/fields`, {
      method: 'PATCH',
      body: { changes, ...(documentType ? { documentType } : {}) },
    });
  }

  approve(reviewId: string, notes?: string): Promise<ApproveResponse> {
    return this.request<ApproveResponse>(`/review/${reviewId}/approve`, {
      method: 'POST',
      body: notes ? { notes } : {},
    });
  }

  reject(reviewId: string, reason: string): Promise<{ reviewId: string; status: string }> {
    return this.request(`/review/${reviewId}/reject`, { method: 'POST', body: { reason } });
  }

  bulkApprove(documentIds: string[]): Promise<BulkApproveResponse> {
    return this.request<BulkApproveResponse>('/review/bulk-approve', {
      method: 'POST',
      body: { documentIds },
    });
  }

  // --- Exports ------------------------------------------------------------

  createExport(input: { format: 'csv' | 'xlsx'; documentType?: string }): Promise<ExportRecord> {
    return this.request<ExportRecord>('/exports', { method: 'POST', body: input });
  }

  listExports(): Promise<{ items: ExportRecord[] }> {
    return this.request('/exports');
  }
}
