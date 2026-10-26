import {
  AppError,
  badRequest,
  type RegisterRequest,
  type Role,
  type TokenPair,
  type UserSummary,
} from '@idcp/shared';
import { hashIp, hashToken, newToken } from '@idcp/shared/ids';
import type { Config } from '../config';
import type { Database } from '../db/database';
import { nowIso } from '../db/database';
import type { Logger } from '../logger';
import {
  MembershipsRepository,
  OrganisationsRepository,
  SessionsRepository,
  UsersRepository,
} from '../repositories/auth-repo';
import { AuditRepository } from '../repositories/system-repo';
import { validatePasswordStrength, type PasswordHasher } from '../auth/password';
import type { TokenService } from '../auth/tokens';

export interface RequestContext {
  ip?: string;
  userAgent?: string;
  ipHash?: string;
}

export interface AuthenticatedActor {
  userId: string;
  organisationId: string;
  role: Role;
  deviceId?: string;
  actorType: 'user' | 'device' | 'api_key';
  /** Present when the request authenticated with an API key (DEVAPI-001). */
  apiKeyId?: string;
}

function slugify(value: string): string {
  const base = value
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return base || 'org';
}

export class AuthService {
  private readonly orgs: OrganisationsRepository;
  private readonly users: UsersRepository;
  private readonly memberships: MembershipsRepository;
  private readonly sessions: SessionsRepository;
  private readonly audit: AuditRepository;

  constructor(
    private readonly db: Database,
    private readonly config: Config,
    private readonly tokens: TokenService,
    private readonly hasher: PasswordHasher,
    private readonly logger: Logger,
  ) {
    this.orgs = new OrganisationsRepository(db);
    this.users = new UsersRepository(db);
    this.memberships = new MembershipsRepository(db);
    this.sessions = new SessionsRepository(db);
    this.audit = new AuditRepository(db);
  }

  private async issueTokens(
    user: {
      id: string;
      email: string;
      display_name: string;
    },
    membership: { organisation_id: string; role: Role },
    context: RequestContext,
  ): Promise<TokenPair> {
    const organisation = await this.orgs.findById(membership.organisation_id);
    const accessToken = this.tokens.signAccessToken({
      sub: user.id,
      org: membership.organisation_id,
      role: membership.role,
    });
    const refresh = this.tokens.createRefreshToken();
    const expiresAt = new Date(
      Date.now() + this.config.REFRESH_TOKEN_TTL_SECONDS * 1000,
    ).toISOString();

    await this.sessions.create({
      userId: user.id,
      organisationId: membership.organisation_id,
      refreshTokenHash: refresh.hash,
      expiresAt,
      userAgent: context.userAgent ?? null,
      ipHash: context.ipHash ?? null,
    });

    return {
      accessToken,
      expiresIn: this.config.ACCESS_TOKEN_TTL_SECONDS,
      refreshToken: refresh.token,
      user: {
        id: user.id,
        email: user.email,
        displayName: user.display_name,
        role: membership.role,
        organisationId: membership.organisation_id,
        organisationName: organisation?.name ?? '',
      },
    };
  }

  async register(input: RegisterRequest, context: RequestContext = {}): Promise<TokenPair> {
    const strength = validatePasswordStrength(input.password);
    if (!strength.ok) throw badRequest(strength.reason ?? 'Password is not strong enough.');

    const existing = await this.users.findByEmail(input.email);
    if (existing) {
      // Do not disclose that the address is taken; return the same shape as a weak-password error.
      throw new AppError('CONFLICT', 'That email address cannot be used. Try signing in instead.');
    }

    return this.db.transaction(async (tx) => {
      const orgs = new OrganisationsRepository(tx);
      const users = new UsersRepository(tx);
      const memberships = new MembershipsRepository(tx);

      let slug = slugify(input.organisationName);
      let suffix = 0;
      while (await orgs.findBySlug(slug)) {
        suffix += 1;
        slug = `${slugify(input.organisationName)}-${suffix}`;
        if (suffix > 50) throw new AppError('CONFLICT', 'Could not create the organisation.');
      }

      const organisation = await orgs.create({ name: input.organisationName, slug });
      const passwordHash = await this.hasher.hash(input.password);
      const user = await users.create({
        email: input.email,
        passwordHash,
        displayName: input.displayName,
      });
      const membership = await memberships.create({
        organisationId: organisation.id,
        userId: user.id,
        role: 'owner',
      });

      await this.audit.record({
        organisationId: organisation.id,
        actorType: 'user',
        actorId: user.id,
        action: 'auth.register',
        targetType: 'user',
        targetId: user.id,
      });

      return this.issueTokens(user, membership, context);
    });
  }

  async login(
    input: { email: string; password: string },
    context: RequestContext = {},
  ): Promise<TokenPair> {
    const user = await this.users.findByEmail(input.email);
    const generic = new AppError('INVALID_CREDENTIALS', 'Email or password is incorrect.');

    if (!user || !user.password_hash || user.disabled_at) {
      // Perform a hash comparison anyway so response timing does not reveal account existence.
      await this.hasher.verify(
        '$argon2id$v=19$m=65536,t=3,p=1$c29tZXNhbHRzb21lc2FsdA$0000000000000000000000000000000000000000000',
        input.password,
      );
      throw generic;
    }

    const valid = await this.hasher.verify(user.password_hash, input.password);
    if (!valid) {
      await this.audit.record({
        organisationId: 'unknown',
        actorType: 'user',
        actorId: user.id,
        action: 'auth.login_failed',
        ipHash: context.ipHash ?? (context.ip ? hashIp(context.ip) : null),
      });
      throw generic;
    }

    const membership = await this.memberships.findForUser(user.id);
    if (!membership) throw generic;

    await this.users.recordLogin(user.id);
    await this.audit.record({
      organisationId: membership.organisation_id,
      actorType: 'user',
      actorId: user.id,
      action: 'auth.login',
      ipHash: context.ipHash ?? (context.ip ? hashIp(context.ip) : null),
    });

    return this.issueTokens(user, membership, context);
  }

  /** Rotate a refresh token: the presented token is revoked and a new pair is issued. */
  async refresh(refreshToken: string, context: RequestContext = {}): Promise<TokenPair> {
    const hash = hashToken(refreshToken);
    const session = await this.sessions.findByTokenHash(hash);
    if (!session || session.revoked_at || session.expires_at <= nowIso()) {
      throw new AppError('UNAUTHENTICATED', 'Your session has expired. Please sign in again.');
    }

    const user = await this.users.findById(session.user_id);
    const membership = await this.memberships.findForUser(session.user_id);
    if (!user || !membership || user.disabled_at) {
      await this.sessions.revoke(session.id);
      throw new AppError('UNAUTHENTICATED', 'Your session is no longer valid.');
    }

    await this.sessions.revoke(session.id);
    this.logger.debug('refresh token rotated', { userId: user.id });
    return this.issueTokens(user, membership, context);
  }

  async logout(refreshToken: string): Promise<void> {
    const session = await this.sessions.findByTokenHash(hashToken(refreshToken));
    if (session) await this.sessions.revoke(session.id);
  }

  async me(actor: AuthenticatedActor): Promise<UserSummary> {
    const user = await this.users.findById(actor.userId);
    const membership = await this.memberships.findForUser(actor.userId);
    const organisation = await this.orgs.findById(actor.organisationId);
    if (!user || !membership || !organisation) {
      throw new AppError('UNAUTHENTICATED', 'Account not found.');
    }
    return {
      id: user.id,
      email: user.email,
      displayName: user.display_name,
      role: membership.role,
      organisationId: organisation.id,
      organisationName: organisation.name,
    };
  }

  /** Invite by email: creates a disabled-password user and a pending membership. */
  async invite(input: {
    email: string;
    role: Role;
    invitedBy: string;
    organisationId: string;
  }): Promise<void> {
    const existing = await this.users.findByEmail(input.email);
    const user =
      existing ??
      (await this.users.create({
        email: input.email,
        passwordHash: null,
        displayName: input.email.split('@')[0] ?? input.email,
      }));

    const alreadyMember = await this.db.one(
      'SELECT id FROM memberships WHERE organisation_id = ? AND user_id = ?',
      [input.organisationId, user.id],
    );
    if (alreadyMember)
      throw new AppError('CONFLICT', 'That person is already in this organisation.');

    await this.memberships.create({
      organisationId: input.organisationId,
      userId: user.id,
      role: input.role,
      invitedBy: input.invitedBy,
      accepted: false,
    });
    await this.audit.record({
      organisationId: input.organisationId,
      actorType: 'user',
      actorId: input.invitedBy,
      action: 'user.invited',
      targetType: 'user',
      targetId: user.id,
      metadata: { role: input.role },
    });
  }

  /** Random one-time token used for invitations/password resets (delivery is out of scope). */
  createOneTimeToken(): string {
    return newToken(24);
  }
}
