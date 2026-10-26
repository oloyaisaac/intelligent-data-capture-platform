import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
import { AppError, isAppError, toErrorEnvelope, type HealthResponse } from '@idcp/shared';
import { MAX_BATCH_FILES } from '../services/batch-service';
import { corsOrigins } from '../config';
import type { Services } from '../services/container';
import { createGuards } from './guards';
import { registerAuthRoutes } from './routes/auth-routes';
import { registerPairingRoutes } from './routes/pairing-routes';
import { registerDocumentRoutes } from './routes/document-routes';
import { registerReviewRoutes } from './routes/review-routes';
import { registerExportRoutes } from './routes/export-routes';
import { registerConnectorRoutes } from './routes/connector-routes';
import { registerOrganisationRoutes } from './routes/organisation-routes';
import { registerTemplateRoutes } from './routes/template-routes';
import { registerApiKeyRoutes } from './routes/api-key-routes';
import { registerRealtimeRoutes } from './routes/realtime-routes';
import { registerBatchRoutes } from './routes/batch-routes';
import { registerProjectRoutes } from './routes/project-routes';
import { registerMarketplaceRoutes } from './routes/marketplace-routes';

/**
 * HTTP application factory. Separated from `index.ts` so tests can build an app around an
 * in-memory database and a fake OCR provider without touching the network.
 */
export async function buildApp(services: Services): Promise<FastifyInstance> {
  const app = Fastify({
    logger: false,
    bodyLimit: services.config.MAX_REQUEST_MB * 1024 * 1024,
    trustProxy: true,
  });

  const allowedOrigins = corsOrigins(services.config);
  await app.register(cors, {
    origin:
      allowedOrigins.length > 0
        ? allowedOrigins
        : services.config.NODE_ENV === 'production'
          ? false
          : true,
    credentials: true,
    exposedHeaders: ['X-Request-Id', 'Retry-After'],
  });

  // A single document upload passes its own `files: 1` limit; the global limit has to leave room
  // for batch uploads (BATCH-001), which carry many files in one request.
  await app.register(multipart, {
    limits: {
      fileSize: services.config.MAX_UPLOAD_MB * 1024 * 1024,
      files: MAX_BATCH_FILES + 1,
      fields: 20,
    },
  });

  // Correlate every log line and error with a request id (API.md §1).
  app.addHook('onRequest', async (request, reply) => {
    const incoming = request.headers['x-request-id'];
    const id = typeof incoming === 'string' && incoming.length <= 128 ? incoming : request.id;
    reply.header('x-request-id', id);
  });

  app.get('/api/v1/health', async (_request, reply) => {
    const dependencies: HealthResponse['dependencies'] = {};
    let status: HealthResponse['status'] = 'ok';
    try {
      await services.db.one('SELECT 1 AS ok');
      dependencies.db = 'ok';
    } catch {
      dependencies.db = 'error';
      status = 'degraded';
    }
    const body: HealthResponse = {
      status,
      version: process.env.npm_package_version ?? '0.1.0',
      uptimeSeconds: Math.round(process.uptime()),
      dependencies,
    };
    return reply.code(status === 'ok' ? 200 : 503).send(body);
  });

  app.setNotFoundHandler((request, reply) => {
    return reply.code(404).send({
      error: {
        code: 'NOT_FOUND',
        message: `No route for ${request.method} ${request.url.split('?')[0]}`,
        requestId: request.id,
      },
    });
  });

  /**
   * One error handler for everything. Application errors keep their code and message; anything
   * else is masked so internal details never reach a client (SECURITY.md §7).
   */
  app.setErrorHandler((error: unknown, request, reply) => {
    const requestId = request.id;
    const fastifyError = error as { statusCode?: number; message?: string };

    if (error instanceof AppError || isAppError(error)) {
      services.logger.debug('request failed', {
        requestId,
        code: error.code,
        status: error.statusCode,
        route: request.url,
      });
      return reply.code(error.statusCode).send(toErrorEnvelope(error, requestId));
    }

    if (fastifyError.statusCode === 413) {
      return reply
        .code(413)
        .send(
          toErrorEnvelope(
            new AppError(
              'PAYLOAD_TOO_LARGE',
              `The upload exceeds ${services.config.MAX_UPLOAD_MB} MB.`,
            ),
            requestId,
          ),
        );
    }

    if (fastifyError.statusCode === 400 && /json/i.test(fastifyError.message ?? '')) {
      return reply
        .code(400)
        .send(toErrorEnvelope(new AppError('INVALID_JSON', 'Malformed JSON body.'), requestId));
    }

    // Framework-level client errors (bad media type, malformed multipart, ...) keep their status
    // but never their internal message.
    const frameworkStatus = fastifyError.statusCode ?? 0;
    if (frameworkStatus >= 400 && frameworkStatus < 500) {
      const mapped: Record<
        number,
        {
          code:
            | 'FIELD_VALIDATION_FAILED'
            | 'UNSUPPORTED_MEDIA_TYPE'
            | 'PAYLOAD_TOO_LARGE'
            | 'RATE_LIMITED'
            | 'NOT_FOUND';
          message: string;
        }
      > = {
        400: { code: 'FIELD_VALIDATION_FAILED', message: 'The request could not be read.' },
        404: { code: 'NOT_FOUND', message: 'Resource not found.' },
        413: { code: 'PAYLOAD_TOO_LARGE', message: 'The upload is too large.' },
        415: {
          code: 'UNSUPPORTED_MEDIA_TYPE',
          message: 'That content type is not supported. Upload a JPEG, PNG, HEIC image or a PDF.',
        },
        429: { code: 'RATE_LIMITED', message: 'Too many requests. Try again shortly.' },
      };
      const entry = mapped[frameworkStatus] ?? {
        code: 'FIELD_VALIDATION_FAILED' as const,
        message: 'The request was rejected.',
      };
      return reply
        .code(frameworkStatus)
        .send(toErrorEnvelope(new AppError(entry.code, entry.message), requestId));
    }

    services.logger.error('unhandled request error', {
      requestId,
      route: request.url,
      method: request.method,
      error,
    });
    return reply.code(500).send(toErrorEnvelope(error, requestId));
  });

  const guards = createGuards(services);
  await app.register(
    async (scope) => {
      registerAuthRoutes(scope, services, guards);
      registerPairingRoutes(scope, services, guards);
      registerDocumentRoutes(scope, services, guards);
      registerReviewRoutes(scope, services, guards);
      registerExportRoutes(scope, services, guards);
      registerConnectorRoutes(scope, services, guards);
      registerOrganisationRoutes(scope, services, guards);
      registerTemplateRoutes(scope, services, guards);
      registerApiKeyRoutes(scope, services, guards);
      registerRealtimeRoutes(scope, services, guards);
      registerBatchRoutes(scope, services, guards);
      registerProjectRoutes(scope, services, guards);
      registerMarketplaceRoutes(scope, services, guards);
    },
    { prefix: '/api/v1' },
  );

  return app;
}
