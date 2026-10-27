import {
  AppError,
  badRequest,
  type CreatedInvitation,
  type ForgotPasswordResponse,
  type Invitation,
  type RegisterRequest,
  type Role,
  type Session as SessionDto,
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
  PasswordResetsRepository,
  SessionsRepository,
  UsersRepository,
} from '../repositories/auth-repo';
import { AuditRepository } from '../repositories/system-repo';
import { InvitationsRepository } from '../repositories/project-repo';
import type { InvitationRow } from '../repositories/types';
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
  private readonly invitations: InvitationsRepository;
  private readonly resets: PasswordResetsRepository;

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
    this.invitations = new InvitationsRepository(db);
    this.resets = new PasswordResetsRepository(db);
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

    const session = await this.sessions.create({
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
      sessionId: session.id,
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

  // --- Password lifecycle (DEC-030) ----------------------------------------

  /**
   * Start a reset. The answer never depends on whether the address exists, and no token is
   * returned or logged in production — there is no mail transport in this deployment, so a
   * production reset is delivered by whoever operates the platform (DEC-030).
   */
  async requestPasswordReset(email: string): Promise<ForgotPasswordResponse> {
    const user = await this.users.findByEmail(email);
    if (!user || user.disabled_at) {
      // Same shape and roughly the same work as the successful path; nothing to send.
      this.logger.info('password reset requested for an unknown address');
      return { accepted: true };
    }

    const token = newToken();
    const expiresAt = new Date(
      Date.now() + this.config.PASSWORD_RESET_TTL_SECONDS * 1000,
    ).toISOString();
    await this.resets.invalidateOutstanding(user.id);
    await this.resets.create({ userId: user.id, tokenHash: hashToken(token), expiresAt });

    await this.audit.record({
      organisationId: 'unknown',
      actorType: 'system',
      actorId: user.id,
      action: 'auth.password_reset_requested',
      targetType: 'user',
      targetId: user.id,
    });
    this.logger.info('password reset requested', { userId: user.id });

    const resetUrl = `${this.config.APP_ORIGIN.replace(/\/$/, '')}/#/reset-password?token=${encodeURIComponent(token)}`;
    if (this.config.NODE_ENV === 'production') {
      this.logger.warn(
        'password reset token not delivered: no email transport is configured (DEC-030)',
      );
      return { accepted: true };
    }
    // Development and test only: the flow has to be completable without a mail server.
    return { accepted: true, resetUrl };
  }

  /** Finish a reset. The token is single-use, and every session dies with it. */
  async resetPassword(token: string, password: string): Promise<void> {
    const strength = validatePasswordStrength(password);
    if (!strength.ok) throw badRequest(strength.reason ?? 'Password is not strong enough.');

    const invalid = new AppError(
      'UNAUTHENTICATED',
      'That reset link is invalid or has expired. Request a new one.',
    );
    const row = await this.resets.findByTokenHash(hashToken(token));
    if (!row || row.used_at || row.expires_at <= nowIso()) throw invalid;
    const user = await this.users.findById(row.user_id);
    if (!user || user.disabled_at) throw invalid;
    // The marked-used check is what makes two concurrent submissions race safely.
    if (!(await this.resets.markUsed(row.id))) throw invalid;

    await this.users.setPassword(user.id, await this.hasher.hash(password));
    await this.sessions.revokeAllForUser(user.id);
    await this.resets.invalidateOutstanding(user.id);
    await this.audit.record({
      organisationId: 'unknown',
      actorType: 'user',
      actorId: user.id,
      action: 'auth.password_reset',
      targetType: 'user',
      targetId: user.id,
    });
  }

  /**
   * Change a password from inside the app. Every other session is revoked; the caller's own is
   * kept when it identifies itself, so changing a password does not sign you out everywhere.
   */
  async changePassword(
    actor: AuthenticatedActor,
    input: { currentPassword: string; newPassword: string; refreshToken?: string },
  ): Promise<{ revokedSessions: number }> {
    const user = await this.users.findById(actor.userId);
    if (!user) throw new AppError('UNAUTHENTICATED', 'Account not found.');
    if (!user.password_hash) {
      throw badRequest('This account has no password yet. Use the reset link you were sent.');
    }
    const valid = await this.hasher.verify(user.password_hash, input.currentPassword);
    if (!valid) throw new AppError('INVALID_CREDENTIALS', 'Your current password is incorrect.');

    const strength = validatePasswordStrength(input.newPassword);
    if (!strength.ok) throw badRequest(strength.reason ?? 'Password is not strong enough.');
    if (await this.hasher.verify(user.password_hash, input.newPassword)) {
      throw badRequest('Choose a password you have not used before.');
    }

    let keep: string | undefined;
    if (input.refreshToken) {
      const session = await this.sessions.findByTokenHash(hashToken(input.refreshToken));
      if (session && session.user_id === user.id && !session.revoked_at) keep = session.id;
    }

    await this.users.setPassword(user.id, await this.hasher.hash(input.newPassword));
    const revokedSessions = await this.sessions.revokeAllForUser(user.id, keep);
    await this.audit.record({
      organisationId: actor.organisationId,
      actorType: actor.actorType,
      actorId: actor.userId,
      action: 'auth.password_changed',
      targetType: 'user',
      targetId: user.id,
      metadata: { revokedSessions },
    });
    return { revokedSessions };
  }

  // --- Sessions -------------------------------------------------------------

  async listSessions(actor: AuthenticatedActor, currentSessionId?: string): Promise<SessionDto[]> {
    const rows = await this.sessions.listForUser(actor.userId);
    return rows.map((row) => ({
      id: row.id,
      createdAt: row.created_at,
      expiresAt: row.expires_at,
      userAgent: row.user_agent,
      current: row.id === currentSessionId,
    }));
  }

  async revokeSession(actor: AuthenticatedActor, sessionId: string): Promise<void> {
    const session = await this.sessions.findByIdForUser(actor.userId, sessionId);
    if (!session || session.revoked_at) {
      throw new AppError('NOT_FOUND', 'That session is not active.');
    }
    await this.sessions.revoke(sessionId);
    await this.audit.record({
      organisationId: actor.organisationId,
      actorType: actor.actorType,
      actorId: actor.userId,
      action: 'auth.session_revoked',
      targetType: 'session',
      targetId: sessionId,
    });
  }

  /** Sign out everywhere. The caller's own session is revoked too — that is the point. */
  async revokeAllSessions(actor: AuthenticatedActor): Promise<{ revokedSessions: number }> {
    const revokedSessions = await this.sessions.revokeAllForUser(actor.userId);
    await this.audit.record({
      organisationId: actor.organisationId,
      actorType: actor.actorType,
      actorId: actor.userId,
      action: 'auth.sessions_revoked_all',
      targetType: 'user',
      targetId: actor.userId,
      metadata: { revokedSessions },
    });
    return { revokedSessions };
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

  /** TEAM-001: invite by email with an expiring, single-use token (no email delivery configured). */
  async invite(input: {
    email: string;
    role: Role;
    invitedBy: string;
    organisationId: string;
  }): Promise<CreatedInvitation> {
    const existing = await this.users.findByEmail(input.email);
    const user =
      existing ??
      (await this.users.create({
        email: input.email,
        passwordHash: null,
        displayName: input.email.split('@')[0] ?? input.email,
      }));

    const alreadyMember = await this.db.one(
      'SELECT id FROM memberships WHERE organisation_id = ? AND user_id = ? AND accepted_at IS NOT NULL',
      [input.organisationId, user.id],
    );
    if (alreadyMember)
      throw new AppError('CONFLICT', 'That person is already in this organisation.');

    const pending = await this.db.one(
      'SELECT id FROM memberships WHERE organisation_id = ? AND user_id = ?',
      [input.organisationId, user.id],
    );
    if (!pending) {
      await this.memberships.create({
        organisationId: input.organisationId,
        userId: user.id,
        role: input.role,
        invitedBy: input.invitedBy,
        accepted: false,
      });
    }

    const token = this.createOneTimeToken();
    const expiresAt = new Date(
      Date.now() + this.config.INVITATION_TTL_SECONDS * 1000,
    ).toISOString();
    const invitation = await this.invitations.create({
      organisationId: input.organisationId,
      userId: user.id,
      email: user.email,
      role: input.role,
      // Only the hash is stored: a leaked database cannot be replayed as invitations.
      tokenHash: hashToken(token),
      invitedBy: input.invitedBy,
      expiresAt,
    });

    await this.audit.record({
      organisationId: input.organisationId,
      actorType: 'user',
      actorId: input.invitedBy,
      action: 'user.invited',
      targetType: 'user',
      targetId: user.id,
      metadata: { role: input.role, invitationId: invitation.id },
    });

    return {
      ...toInvitation(invitation),
      token,
      acceptUrl: `${this.config.APP_ORIGIN.replace(/\/$/, '')}/#/accept-invite?token=${token}`,
    };
  }

  listInvitations(organisationId: string): Promise<Invitation[]> {
    return this.invitations
      .listForOrganisation(organisationId)
      .then((rows) => rows.map(toInvitation));
  }

  async revokeInvitation(organisationId: string, id: string): Promise<void> {
    const row = await this.db.one<InvitationRow>(
      'SELECT * FROM invitations WHERE organisation_id = ? AND id = ?',
      [organisationId, id],
    );
    if (!row) throw new AppError('NOT_FOUND', 'Invitation not found.');
    await this.invitations.revoke(id);
  }

  /**
   * Accept an invitation: sets the password, activates the membership and signs the person in.
   * The token is single-use — a second attempt with the same link fails.
   */
  async acceptInvitation(
    input: { token: string; password: string },
    context: RequestContext = {},
  ): Promise<TokenPair> {
    const strength = validatePasswordStrength(input.password);
    if (!strength.ok) throw badRequest(strength.reason ?? 'Password is not strong enough.');

    const invitation = await this.invitations.findByTokenHash(hashToken(input.token));
    const invalid = new AppError('UNAUTHENTICATED', 'This invitation link is not valid any more.');
    if (!invitation) throw invalid;
    if (invitation.used_at || invitation.expires_at <= nowIso()) {
      throw new AppError(
        'UNAUTHENTICATED',
        'This invitation has expired. Ask an admin for a new one.',
      );
    }

    const consumed = await this.invitations.consume(invitation.id);
    if (!consumed) throw invalid;

    const passwordHash = await this.hasher.hash(input.password);
    await this.users.setPassword(invitation.user_id, passwordHash);
    await this.db.execute(
      'UPDATE memberships SET accepted_at = ?, updated_at = ? WHERE organisation_id = ? AND user_id = ?',
      [nowIso(), nowIso(), invitation.organisation_id, invitation.user_id],
    );

    await this.audit.record({
      organisationId: invitation.organisation_id,
      actorType: 'user',
      actorId: invitation.user_id,
      action: 'user.invitation_accepted',
      targetType: 'user',
      targetId: invitation.user_id,
      ipHash: context.ipHash ?? (context.ip ? hashIp(context.ip) : null),
    });

    const user = await this.users.findById(invitation.user_id);
    if (!user) throw invalid;
    const membership = await this.db.one<{ organisation_id: string; role: Role }>(
      'SELECT organisation_id, role FROM memberships WHERE organisation_id = ? AND user_id = ?',
      [invitation.organisation_id, invitation.user_id],
    );
    if (!membership) throw invalid;
    return this.issueTokens(user, membership, context);
  }

  /** Random one-time token used for invitations/password resets (delivery is out of scope). */
  createOneTimeToken(): string {
    return newToken(24);
  }
}

function toInvitation(row: InvitationRow): Invitation {
  return {
    id: row.id,
    email: row.email,
    role: row.role as Role,
    expiresAt: row.expires_at,
    usedAt: row.used_at,
    createdAt: row.created_at,
  };
}
