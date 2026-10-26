import type { FastifyInstance } from 'fastify';
import { loadConfig, type Config } from '../src/config';
import { createTestDatabase } from '../src/db';
import { createLogger } from '../src/logger';
import { MemoryStorage } from '../src/storage';
import { InMemoryRealtimeHub } from '../src/realtime/hub';
import { buildServices, type Services } from '../src/services/container';
import { buildApp } from '../src/http/app';
import type { OcrProvider, OcrResult } from '../src/ai/providers/types';
import type { Database } from '../src/db/database';

/**
 * Test harness: a real API over an in-memory SQLite database and in-memory storage, with a fake
 * OCR provider so the suite never needs a network or an OCR engine.
 */
export class FakeOcrProvider implements OcrProvider {
  readonly name = 'fake-ocr';
  readonly isLocal = true;
  private text = '';
  private failure: Error | null = null;
  calls = 0;

  setText(text: string): void {
    this.text = text;
    this.failure = null;
  }

  failWith(error: Error): void {
    this.failure = error;
  }

  async ocr(): Promise<OcrResult> {
    this.calls += 1;
    if (this.failure) throw this.failure;
    return {
      text: this.text,
      words: this.text
        .split(/\s+/)
        .filter(Boolean)
        .map((word) => ({ text: word, confidence: 0.97 })),
      provider: this.name,
      latencyMs: 5,
      costMicros: 0,
    };
  }
}

export interface ApiResponse {
  statusCode: number;
  headers: Headers;
  body: string;
  json<T = Record<string, unknown>>(): T;
  buffer(): Buffer;
}

export interface ApiClient {
  json(
    method: string,
    path: string,
    options?: {
      token?: string;
      body?: unknown;
      headers?: Record<string, string>;
      rawBody?: Buffer;
    },
  ): Promise<ApiResponse>;
  upload(
    token: string,
    options?: {
      content?: Buffer;
      filename?: string;
      contentType?: string;
      idempotencyKey?: string;
      documentType?: string;
    },
  ): Promise<ApiResponse>;
  get(path: string, token?: string): Promise<ApiResponse>;
  download(path: string, token: string): Promise<ApiResponse>;
}

export interface Harness {
  app: FastifyInstance;
  api: ApiClient;
  services: Services;
  db: Database;
  storage: MemoryStorage;
  hub: InMemoryRealtimeHub;
  ocr: FakeOcrProvider;
  config: Config;
  baseUrl: string;
  close(): Promise<void>;
}

export function testConfig(overrides: NodeJS.ProcessEnv = {}): Config {
  return loadConfig({
    NODE_ENV: 'test',
    DB_DRIVER: 'sqlite',
    SQLITE_PATH: ':memory:',
    JWT_SECRET: 'test-secret-that-is-long-enough-0123456789',
    LOG_LEVEL: 'error',
    WORKER_ENABLED: 'false',
    RATE_LIMIT_ENABLED: 'false',
    AI_PROVIDER: 'local',
    MAX_UPLOAD_MB: '5',
    MAX_REQUEST_MB: '10',
    ...overrides,
  } as NodeJS.ProcessEnv);
}

export async function createHarness(overrides: NodeJS.ProcessEnv = {}): Promise<Harness> {
  const config = testConfig(overrides);
  const db = await createTestDatabase();
  const logger = createLogger({ level: 'error', sink: () => undefined });
  const storage = new MemoryStorage();
  const hub = new InMemoryRealtimeHub();
  const ocr = new FakeOcrProvider();

  const services = buildServices({ config, db, logger, storage, hub, provider: ocr });
  const app = await buildApp(services);
  await app.ready();
  // A real listener on an ephemeral port: no mocking of the transport, and it keeps the suite
  // independent of Jest's ESM handling inside Fastify's inject helper.
  await app.listen({ port: 0, host: '127.0.0.1' });
  const address = app.server.address();
  if (!address || typeof address === 'string') throw new Error('test server did not bind');
  const baseUrl = `http://127.0.0.1:${address.port}`;

  const toResponse = async (response: Response): Promise<ApiResponse> => {
    const buffer = Buffer.from(await response.arrayBuffer());
    return {
      statusCode: response.status,
      headers: response.headers,
      body: buffer.toString('utf8'),
      json: <T>() => JSON.parse(buffer.toString('utf8') || '{}') as T,
      buffer: () => buffer,
    };
  };

  const api: ApiClient = {
    async json(method, path, options = {}) {
      const headers: Record<string, string> = { ...options.headers };
      if (options.token) headers.authorization = `Bearer ${options.token}`;
      let body: string | Uint8Array | undefined;
      if (options.rawBody) {
        body = options.rawBody;
        headers['content-type'] = headers['content-type'] ?? 'application/octet-stream';
      } else if (options.body !== undefined) {
        body = JSON.stringify(options.body);
        headers['content-type'] = 'application/json';
      }
      const response = await fetch(`${baseUrl}${path}`, { method, headers, body });
      return toResponse(response);
    },

    async upload(token, options = {}) {
      const form = new FormData();
      const content = options.content ?? fakePng();
      const mime = options.contentType ?? 'image/png';
      form.append(
        'file',
        new Blob([new Uint8Array(content)], { type: mime }),
        options.filename ?? 'scan.png',
      );
      if (options.documentType) form.append('documentType', options.documentType);
      const headers: Record<string, string> = { authorization: `Bearer ${token}` };
      if (options.idempotencyKey) headers['idempotency-key'] = options.idempotencyKey;
      const response = await fetch(`${baseUrl}/api/v1/documents`, {
        method: 'POST',
        headers,
        body: form,
      });
      return toResponse(response);
    },

    async get(path, token) {
      return api.json('GET', path, { token });
    },

    async download(path, token) {
      const response = await fetch(`${baseUrl}${path}`, {
        headers: { authorization: `Bearer ${token}` },
      });
      return toResponse(response);
    },
  };

  return {
    app,
    api,
    services,
    db,
    storage,
    hub,
    ocr,
    config,
    baseUrl,
    close: async () => {
      await app.close();
      await db.close();
    },
  };
}

/** A tiny but structurally valid PNG so content sniffing accepts it. */
export function fakePng(extra = ''): Buffer {
  const header = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
  return Buffer.concat([header, Buffer.from(extra, 'utf8')]);
}

export function fakePdf(extra = ''): Buffer {
  return Buffer.concat([Buffer.from('%PDF-1.7\n', 'utf8'), Buffer.from(extra, 'utf8')]);
}

export interface TestAccount {
  accessToken: string;
  refreshToken: string;
  userId: string;
  organisationId: string;
  email: string;
}

export async function registerAccount(
  harness: Harness,
  overrides: { email?: string; organisationName?: string; password?: string } = {},
): Promise<TestAccount> {
  const email = overrides.email ?? `user-${Math.random().toString(36).slice(2, 10)}@example.com`;
  const response = await harness.api.json('POST', '/api/v1/auth/register', {
    body: {
      email,
      password: overrides.password ?? 'correct horse battery staple',
      displayName: 'Test User',
      organisationName: overrides.organisationName ?? 'Test Trading Ltd',
    },
  });
  if (response.statusCode !== 201) {
    throw new Error(`register failed: ${response.statusCode} ${response.body}`);
  }
  const body = response.json() as {
    accessToken: string;
    refreshToken: string;
    user: { id: string; organisationId: string };
  };
  return {
    accessToken: body.accessToken,
    refreshToken: body.refreshToken,
    userId: body.user.id,
    organisationId: body.user.organisationId,
    email,
  };
}

export function authHeader(account: TestAccount): Record<string, string> {
  return { authorization: `Bearer ${account.accessToken}` };
}

export function uploadDocument(
  harness: Harness,
  account: TestAccount,
  options: { content?: Buffer; idempotencyKey?: string; documentType?: string } = {},
) {
  return harness.api.upload(account.accessToken, options);
}

/** Wait for the worker to finish all runnable jobs. */
export async function drainWorker(harness: Harness): Promise<void> {
  await harness.services.worker.drain();
}

export async function openReview(
  harness: Harness,
  account: TestAccount,
  documentId: string,
): Promise<{
  reviewId: string;
  documentType: string;
  blocking: Array<{ path: string; reason: string; confidence: number }>;
}> {
  const response = await harness.api.json('POST', `/api/v1/documents/${documentId}/review`, {
    token: account.accessToken,
  });
  if (response.statusCode !== 200) throw new Error(`open review failed: ${response.body}`);
  return response.json();
}

export async function approveDocument(
  harness: Harness,
  account: TestAccount,
  documentId: string,
): Promise<void> {
  const review = await openReview(harness, account, documentId);

  const changes = review.blocking
    .filter((field) => field.path !== 'documentType')
    .map((field) => ({ fieldPath: field.path, value: 'confirmed' }));
  const confirmType = review.blocking.some((field) => field.path === 'documentType');
  if (changes.length > 0 || confirmType) {
    const patched = await harness.api.json('PATCH', `/api/v1/review/${review.reviewId}/fields`, {
      token: account.accessToken,
      body: { changes, ...(confirmType ? { documentType: review.documentType } : {}) },
    });
    if (patched.statusCode !== 200) throw new Error(`patch failed: ${patched.body}`);
  }

  const approved = await harness.api.json('POST', `/api/v1/review/${review.reviewId}/approve`, {
    token: account.accessToken,
    body: {},
  });
  if (approved.statusCode !== 200) throw new Error(`approve failed: ${approved.body}`);
}

export const SAMPLE_INVOICE_TEXT = `ACME SUPPLIES LIMITED
Plot 12, Kampala Road
Tel: +256 700 000000

INVOICE
Invoice No: INV-1042
Invoice Date: 26/10/2026
Due Date: 25/11/2026
TIN: 1001234567

Bill To: Demo Trading Ltd

Description            Qty   Unit Price   Amount
Cement 50kg bags       10    35,000       350,000
Steel bars 12mm        5     120,000      600,000

Subtotal: UGX 950,000
VAT: UGX 171,000
Total: UGX 1,121,000`;

export const SAMPLE_RECEIPT_TEXT = `KAMPALA HARDWARE STORE
RECEIPT
Receipt No: RCT-88
Date: 24/10/2026
Cash: UGX 50,000
Change due: UGX 5,000
Thank you for your purchase`;

export const SAMPLE_ID_TEXT = `REPUBLIC OF UGANDA
NATIONAL ID
Document No: UG-123456789
Surname: NAMONO
Given names: Amina Grace
Date of Birth: 14/03/1994
Place of Birth: Kampala`;

/**
 * Completes an invitation for a user created via POST /users/invite.
 *
 * The product sends a one-time link; delivery is out of scope here, so the helper sets the
 * password and marks the membership accepted — exactly the state an accepted invite ends in.
 */
export async function acceptInvite(
  harness: Harness,
  email: string,
  password = 'correct horse battery staple',
): Promise<TestAccount> {
  const row = await harness.db.one<{ id: string; organisation_id: string }>(
    `SELECT u.id, m.organisation_id FROM users u
       JOIN memberships m ON m.user_id = u.id
      WHERE u.email = ?`,
    [email],
  );
  if (!row) throw new Error(`no invited user for ${email}`);

  const hash = await harness.services.hasher.hash(password);
  await harness.db.execute('UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?', [
    hash,
    new Date().toISOString(),
    row.id,
  ]);
  await harness.db.execute(
    'UPDATE memberships SET accepted_at = ? WHERE user_id = ? AND organisation_id = ?',
    [new Date().toISOString(), row.id, row.organisation_id],
  );

  const response = await harness.api.json('POST', '/api/v1/auth/login', {
    body: { email, password },
  });
  if (response.statusCode !== 200) throw new Error(`login failed for invitee: ${response.body}`);
  const body = response.json<{
    accessToken: string;
    refreshToken: string;
    user: { id: string; organisationId: string };
  }>();
  return {
    accessToken: body.accessToken,
    refreshToken: body.refreshToken,
    userId: body.user.id,
    organisationId: body.user.organisationId,
    email,
  };
}
