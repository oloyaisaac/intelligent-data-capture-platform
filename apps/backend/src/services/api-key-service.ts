import {
  AppError,
  type ApiKey,
  type ApiKeyScope,
  type CreatedApiKey,
  type Role,
} from '@idcp/shared';
import { hashToken, newToken } from '@idcp/shared/ids';
import type { Logger } from '../logger';
import type { ApiKeysRepository } from '../repositories/apikey-repo';
import type { AuditRepository } from '../repositories/system-repo';
import type { MembershipsRepository } from '../repositories/auth-repo';
import type { ApiKeyRow } from '../repositories/types';
import type { AuthenticatedActor } from './auth-service';

/**
 * Developer API keys (DEVAPI-001).
 *
 * The secret is generated once, returned once, and stored only as a SHA-256 hash with a short
 * prefix for display. Scopes currently map to a broad role ladder, not per-operation permissions;
 * key management separately requires a signed-in owner or admin.
 */

const KEY_PREFIX = 'idcp_';
const KEY_BYTES = 32;

const SCOPE_ROLE: Record<ApiKeyScope, Role> = {
  'documents:read': 'viewer',
  'review:write': 'reviewer',
  'documents:write': 'reviewer',
  'exports:read': 'viewer',
  'connectors:write': 'admin',
  admin: 'admin',
};

export function roleForScopes(scopes: string[]): Role | null {
  let highest: Role | null = null;
  const ladder: Role[] = ['viewer', 'reviewer', 'admin', 'owner'];
  for (const scope of scopes) {
    const role = SCOPE_ROLE[scope as ApiKeyScope];
    if (!role) continue;
    if (!highest || ladder.indexOf(role) > ladder.indexOf(highest)) highest = role;
  }
  return highest;
}

export interface ApiKeyPrincipal {
  organisationId: string;
  userId: string;
  role: Role;
  scopes: ApiKeyScope[];
  keyId: string;
}

export interface ApiKeyServiceRepositories {
  keys: Pick<ApiKeysRepository, 'create' | 'list' | 'revoke' | 'findByHash' | 'touch'>;
  memberships: Pick<MembershipsRepository, 'findActiveForOrganisation'>;
  audit: Pick<AuditRepository, 'record'>;
}

export class ApiKeyService {
  private readonly keys: ApiKeyServiceRepositories['keys'];
  private readonly memberships: ApiKeyServiceRepositories['memberships'];
  private readonly audit: ApiKeyServiceRepositories['audit'];

  constructor(
    repositories: ApiKeyServiceRepositories,
    private readonly logger: Logger,
  ) {
    this.keys = repositories.keys;
    this.memberships = repositories.memberships;
    this.audit = repositories.audit;
  }

  async create(
    actor: AuthenticatedActor,
    input: { name: string; scopes: ApiKeyScope[]; expiresInDays?: number },
  ): Promise<CreatedApiKey> {
    requireKeyManager(actor);
    if (
      input.expiresInDays !== undefined &&
      (!Number.isInteger(input.expiresInDays) ||
        input.expiresInDays < 1 ||
        input.expiresInDays > 730)
    ) {
      throw new AppError(
        'FIELD_VALIDATION_FAILED',
        'API key expiry must be between 1 and 730 days.',
      );
    }
    if (input.scopes.includes('admin') && actor.role !== 'owner') {
      throw new AppError('ROLE_REQUIRED', 'Only an owner can issue a key with the admin scope.');
    }

    const secret = `${KEY_PREFIX}${newToken(KEY_BYTES)}`;
    const row = await this.keys.create({
      organisationId: actor.organisationId,
      name: input.name,
      keyHash: hashToken(secret),
      keyPrefix: secret.slice(0, KEY_PREFIX.length + 6),
      scopes: input.scopes,
      createdBy: actor.userId,
      expiresAt:
        input.expiresInDays === undefined
          ? null
          : new Date(Date.now() + input.expiresInDays * 86_400_000).toISOString(),
    });

    await this.audit.record({
      organisationId: actor.organisationId,
      actorType: actor.actorType,
      actorId: actor.userId,
      action: 'api_key.created',
      targetType: 'api_key',
      targetId: row.id,
      metadata: { scopes: input.scopes },
    });

    this.logger.info('api key created', { apiKeyId: row.id, scopes: input.scopes.length });
    return { ...toApiKey(row), key: secret, shownOnce: true };
  }

  async list(actor: AuthenticatedActor): Promise<ApiKey[]> {
    requireKeyManager(actor);
    const rows = await this.keys.list(actor.organisationId);
    return rows.map(toApiKey);
  }

  async revoke(actor: AuthenticatedActor, id: string): Promise<ApiKey> {
    requireKeyManager(actor);
    const row = await this.keys.revoke(actor.organisationId, id);
    if (!row) throw new AppError('NOT_FOUND', 'API key not found.');
    await this.audit.record({
      organisationId: actor.organisationId,
      actorType: actor.actorType,
      actorId: actor.userId,
      action: 'api_key.revoked',
      targetType: 'api_key',
      targetId: id,
    });
    return toApiKey(row);
  }

  /** Resolves an `X-API-Key` header into a principal, or null when it is not valid. */
  async authenticate(rawKey: string): Promise<ApiKeyPrincipal | null> {
    if (!rawKey.startsWith(KEY_PREFIX) || rawKey.length < 24) return null;
    const row = await this.keys.findByHash(hashToken(rawKey));
    if (!row || row.revoked_at || !isUnexpired(row.expires_at)) return null;

    const scopes = parseScopes(row.scopes);
    const role = roleForScopes(scopes);
    if (!role) return null;

    // The key acts as its creator, re-checked against the live membership: a removed user's key
    // stops working immediately.
    const membership = await this.memberships.findActiveForOrganisation(
      row.created_by,
      row.organisation_id,
    );
    if (!membership) return null;

    await this.keys.touch(row.key_hash);
    return {
      organisationId: row.organisation_id,
      userId: row.created_by,
      role: roleAtMost(role, membership.role as Role),
      scopes,
      keyId: row.id,
    };
  }
}

function requireKeyManager(actor: AuthenticatedActor): void {
  if (actor.actorType !== 'user' || !['owner', 'admin'].includes(actor.role)) {
    throw new AppError('ROLE_REQUIRED', 'Only signed-in owners and admins can manage API keys.');
  }
}

function isUnexpired(value: unknown): boolean {
  if (value === null) return true;
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value))
    return false;
  const millis = Date.parse(value);
  return Number.isFinite(millis) && new Date(millis).toISOString() === value && millis > Date.now();
}

/** A key can never exceed the role of the person who created it, even after a role change. */
function roleAtMost(scopeRole: Role, actualRole: Role): Role {
  const ladder: Role[] = ['viewer', 'reviewer', 'admin', 'owner'];
  return ladder.indexOf(scopeRole) < ladder.indexOf(actualRole) ? scopeRole : actualRole;
}

function parseScopes(raw: string): ApiKeyScope[] {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? (parsed as ApiKeyScope[]) : [];
  } catch {
    return [];
  }
}

function toApiKey(row: ApiKeyRow): ApiKey {
  return {
    id: row.id,
    name: row.name,
    prefix: row.key_prefix,
    scopes: parseScopes(row.scopes),
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at,
    revokedAt: row.revoked_at,
    expiresAt: row.expires_at,
  };
}
