import type { FastifyReply, FastifyRequest } from 'fastify';
import { AppError, roleAtLeast, type Role } from '@idcp/shared';
import { hashIp, isUuid } from '@idcp/shared/ids';
import type { Services } from '../services/container';
import type { AuthenticatedActor } from '../services/auth-service';
import { MembershipsRepository } from '../repositories/auth-repo';

declare module 'fastify' {
  interface FastifyRequest {
    actor?: AuthenticatedActor;
    clientIpHash?: string;
  }
}

/**
 * Authentication and authorisation for every non-public route (SECURITY.md §5).
 *
 * Three credentials are accepted:
 *   - `Authorization: Bearer <access token>` — a signed-in person
 *   - `X-Device-Credential: <credential>`     — a paired device acting for its owner
 *   - `X-API-Key: <key>`                      — a machine client, limited by its scopes
 *
 * Authorisation is always re-checked server-side against the current membership: a token issued
 * before a role change does not keep its old privileges.
 */
export function createGuards(services: Services) {
  const memberships = new MembershipsRepository(services.db);

  async function resolveActor(request: FastifyRequest): Promise<AuthenticatedActor> {
    const deviceCredential = request.headers['x-device-credential'];
    if (typeof deviceCredential === 'string' && deviceCredential.length > 0) {
      const device = await services.pairing.findActiveDeviceByCredential(deviceCredential);
      if (!device)
        throw new AppError('UNAUTHENTICATED', 'This device is not paired or was revoked.');
      const membership = await memberships.findForUser(device.user_id);
      if (!membership) throw new AppError('UNAUTHENTICATED', 'This device is no longer valid.');
      return {
        userId: device.user_id,
        organisationId: device.organisation_id,
        role: membership.role,
        deviceId: device.id,
        actorType: 'device',
      };
    }

    // Machine clients present a key rather than a bearer token (DEVAPI-001).
    const apiKeyHeader = request.headers['x-api-key'];
    if (typeof apiKeyHeader === 'string' && apiKeyHeader.length > 0) {
      const principal = await services.apiKeys.authenticate(apiKeyHeader);
      if (!principal)
        throw new AppError('UNAUTHENTICATED', 'This API key is not valid or was revoked.');
      return {
        userId: principal.userId,
        organisationId: principal.organisationId,
        role: principal.role,
        actorType: 'api_key',
        apiKeyId: principal.keyId,
      };
    }

    const header = request.headers.authorization;
    if (!header?.startsWith('Bearer ')) {
      throw new AppError('UNAUTHENTICATED', 'Sign in to continue.');
    }
    const claims = services.tokens.verifyAccessToken(header.slice('Bearer '.length).trim());
    if (!claims) throw new AppError('TOKEN_EXPIRED', 'Your session has expired. Sign in again.');

    const membership = await memberships.findForUser(claims.sub);
    if (!membership) throw new AppError('UNAUTHENTICATED', 'Account is no longer active.');

    return {
      userId: claims.sub,
      organisationId: membership.organisation_id,
      role: membership.role,
      actorType: 'user',
    };
  }

  /** Resolves the actor once per request and caches it on the request object. */
  const authenticate = async (request: FastifyRequest): Promise<AuthenticatedActor> => {
    if (!request.actor) {
      request.actor = await resolveActor(request);
      request.clientIpHash = request.ip ? hashIp(request.ip) : undefined;
    }
    return request.actor;
  };

  const requireRole = (role: Role) => async (request: FastifyRequest, _reply?: FastifyReply) => {
    const actor = await authenticate(request);
    if (!roleAtLeast(actor.role, role)) {
      throw new AppError('ROLE_REQUIRED', 'You do not have permission to do that.');
    }
  };

  return {
    authenticate,
    requireRole,
    /** Validates a path parameter that must be a UUID before it reaches a query. */
    uuidParam(request: FastifyRequest, name = 'id'): string {
      const value = (request.params as Record<string, string>)[name];
      if (!value || !isUuid(value)) throw new AppError('NOT_FOUND', 'Resource not found.');
      return value;
    },
  };
}

export type Guards = ReturnType<typeof createGuards>;
