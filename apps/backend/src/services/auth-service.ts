import {
  AppError,
  badRequest,
  type CreatedInvitation,
  type ForgotPasswordResponse,
  type Invitation,
  type RegisterRequest,
  type Role,
  type LoginResponse,
  type MfaConfirmResponse,
  type MfaStartResponse,
  type MfaStatus,
  type Session as SessionDto,
  LEGAL_VERSION,
  type TermsAcceptance,
  type TokenPair,
  type UserSummary,
} from '@idcp/shared';
import { randomBytes } from 'node:crypto';
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
import { generateTotpSecret, otpauthUri, verifyTotp } from '../auth/totp';
import type { SecretBox } from './crypto';
import type { Mailer } from './mailer';

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
    /** Encrypts TOTP secrets at rest; the AAD binds each ciphertext to its account (DEC-034). */
    private readonly secrets: SecretBox,
    private readonly mailer: Mailer | null = null,
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
    db: Database = this.db,
  ): Promise<TokenPair> {
    const organisation = await new OrganisationsRepository(db).findById(membership.organisation_id);
    const accessToken = this.tokens.signAccessToken({
      sub: user.id,
      org: membership.organisation_id,
      role: membership.role,
    });
    const refresh = this.tokens.createRefreshToken();
    const expiresAt = new Date(
      Date.now() + this.config.REFRESH_TOKEN_TTL_SECONDS * 1000,
    ).toISOString();

    const session = await new SessionsRepository(db).create({
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
        // The checkbox is validated at the edge (`acceptTerms: true`); the record is written here,
        // server-side, so it cannot be forged or skipped by another client (DEC-032).
        termsAcceptedAt: nowIso(),
        termsVersion: LEGAL_VERSION,
      });
      const membership = await memberships.create({
        organisationId: organisation.id,
        userId: user.id,
        role: 'owner',
      });

      await new AuditRepository(tx).record({
        organisationId: organisation.id,
        actorType: 'user',
        actorId: user.id,
        action: 'auth.register',
        targetType: 'user',
        targetId: user.id,
        metadata: { termsVersion: LEGAL_VERSION },
      });

      return this.issueTokens(user, membership, context, tx);
    });
  }

  async login(
    input: { email: string; password: string },
    context: RequestContext = {},
  ): Promise<LoginResponse> {
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

    // The password was right; that is half of what MFA asks for (DEC-034). No tokens yet: a
    // challenge token proves *this* password check and expires in five minutes.
    // An enabled factor must never silently fall back to password-only login, even if its
    // encrypted secret is missing or unreadable. Recovery codes can still be used in the challenge.
    if (user.mfa_enabled_at) {
      await this.audit.record({
        organisationId: membership.organisation_id,
        actorType: 'user',
        actorId: user.id,
        action: 'auth.login',
        ipHash: context.ipHash ?? (context.ip ? hashIp(context.ip) : null),
        metadata: { mfa: 'challenge_issued' },
      });
      return {
        mfaRequired: true,
        challengeToken: this.tokens.signMfaChallenge(user.id),
        expiresInSeconds: 300,
      };
    }

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

  // --- Multi-factor authentication (DEC-034) -------------------------------

  private mfaContext(userId: string): string {
    return `mfa:${userId}`;
  }

  private decryptSecret(user: { id: string; mfa_secret_enc: string | null }): string | null {
    if (!user.mfa_secret_enc) return null;
    try {
      return this.secrets.decrypt(user.mfa_secret_enc, this.mfaContext(user.id));
    } catch {
      // The factor stays enabled: a recovery code can still be used, or support must help the
      // user recover access. Never silently downgrade an enabled factor to password-only login.
      this.logger.warn('stored MFA secret could not be decrypted', { userId: user.id });
      return null;
    }
  }

  async mfaStatus(actor: AuthenticatedActor): Promise<MfaStatus> {
    const user = await this.users.findById(actor.userId);
    if (!user) throw new AppError('UNAUTHENTICATED', 'Account not found.');
    return {
      enabled: user.mfa_enabled_at !== null,
      enabledAt: user.mfa_enabled_at,
      recoveryCodesRemaining: parseRecoveryHashes(user.mfa_recovery_hashes).length,
    };
  }

  /** Step one: prove the password, receive a secret that is not yet active. */
  async startMfaEnrolment(
    actor: AuthenticatedActor,
    password: string,
    context: RequestContext = {},
  ): Promise<MfaStartResponse> {
    const user = await this.users.findById(actor.userId);
    if (!user || user.disabled_at) throw new AppError('UNAUTHENTICATED', 'Account not found.');
    if (user.mfa_enabled_at) {
      throw new AppError('CONFLICT', 'Two-factor authentication is already on for this account.');
    }
    if (!user.password_hash) {
      throw new AppError('CONFLICT', 'Set a password before turning on two-factor authentication.');
    }
    const valid = await this.hasher.verify(user.password_hash, password);
    if (!valid) {
      await this.audit.record({
        organisationId: actor.organisationId,
        actorType: 'user',
        actorId: user.id,
        action: 'auth.login_failed',
        ipHash: context.ipHash ?? (context.ip ? hashIp(context.ip) : null),
        metadata: { step: 'mfa_enrolment' },
      });
      throw new AppError('INVALID_CREDENTIALS', 'That password is not correct.');
    }

    const secret = generateTotpSecret();
    await this.users.setMfaSecret(user.id, this.secrets.encrypt(secret, this.mfaContext(user.id)));
    const issuer = 'IDCP';
    return {
      secret,
      otpauthUri: otpauthUri({ secret, account: user.email, issuer }),
      issuer,
      account: user.email,
    };
  }

  /** Step two: prove the app produces codes, then turn the factor on and hand out recovery codes. */
  async confirmMfaEnrolment(
    actor: AuthenticatedActor,
    code: string,
    context: RequestContext = {},
  ): Promise<MfaConfirmResponse> {
    const user = await this.users.findById(actor.userId);
    if (!user || user.disabled_at) throw new AppError('UNAUTHENTICATED', 'Account not found.');
    if (user.mfa_enabled_at) {
      throw new AppError('CONFLICT', 'Two-factor authentication is already on for this account.');
    }
    const secret = this.decryptSecret(user);
    if (!secret) {
      throw new AppError('CONFLICT', 'Start the setup again: this account has no pending secret.');
    }
    if (!verifyTotp(secret, code)) {
      throw new AppError('INVALID_CODE', 'That code is not valid. Codes change every 30 seconds.');
    }

    const codes = this.createRecoveryCodes(10);
    const enabledAt = await this.users.enableMfa(
      user.id,
      codes.map((plain) => hashToken(normaliseRecoveryCode(plain))),
    );
    await this.audit.record({
      organisationId: actor.organisationId,
      actorType: 'user',
      actorId: user.id,
      action: 'auth.mfa_enabled',
      ipHash: context.ipHash ?? (context.ip ? hashIp(context.ip) : null),
    });
    return { enabledAt, recoveryCodes: codes };
  }

  /** Turning the factor off is a downgrade, so it needs both the password and a live code. */
  async disableMfa(
    actor: AuthenticatedActor,
    password: string,
    code: string,
    context: RequestContext = {},
  ): Promise<void> {
    const user = await this.users.findById(actor.userId);
    if (!user || user.disabled_at) throw new AppError('UNAUTHENTICATED', 'Account not found.');
    if (!user.mfa_enabled_at)
      throw new AppError('CONFLICT', 'Two-factor authentication is not on.');
    if (!user.password_hash || !(await this.hasher.verify(user.password_hash, password))) {
      throw new AppError('INVALID_CREDENTIALS', 'That password is not correct.');
    }
    if (!(await this.consumeSecondFactor(user, code, actor.organisationId))) {
      throw new AppError('INVALID_CODE', 'That code is not valid. Codes change every 30 seconds.');
    }
    await this.users.disableMfa(user.id);
    await this.audit.record({
      organisationId: actor.organisationId,
      actorType: 'user',
      actorId: user.id,
      action: 'auth.mfa_disabled',
      ipHash: context.ipHash ?? (context.ip ? hashIp(context.ip) : null),
    });
  }

  /** New recovery codes, authorised by a live code from the app. */
  async regenerateRecoveryCodes(
    actor: AuthenticatedActor,
    code: string,
  ): Promise<{ recoveryCodes: string[] }> {
    const user = await this.users.findById(actor.userId);
    if (!user || !user.mfa_enabled_at) {
      throw new AppError('CONFLICT', 'Two-factor authentication is not on.');
    }
    if (!(await this.consumeSecondFactor(user, code, actor.organisationId))) {
      throw new AppError('INVALID_CODE', 'That code is not valid. Codes change every 30 seconds.');
    }
    const codes = this.createRecoveryCodes(10);
    await this.users.setRecoveryHashes(
      user.id,
      codes.map((plain) => hashToken(normaliseRecoveryCode(plain))),
    );
    await this.audit.record({
      organisationId: actor.organisationId,
      actorType: 'user',
      actorId: user.id,
      action: 'auth.mfa_recovery_regenerated',
    });
    return { recoveryCodes: codes };
  }

  /** Step two of a login: exchange the challenge and a code for a real session. */
  async completeMfaLogin(
    challengeToken: string,
    code: string,
    context: RequestContext = {},
  ): Promise<TokenPair> {
    const challenge = this.tokens.verifyMfaChallenge(challengeToken);
    const invalid = new AppError(
      'UNAUTHENTICATED',
      'That sign-in attempt has expired. Start again.',
    );
    if (!challenge) throw invalid;

    const user = await this.users.findById(challenge.userId);
    const membership = await this.memberships.findForUser(challenge.userId);
    if (!user || !membership || user.disabled_at || !user.mfa_enabled_at) throw invalid;

    if (!(await this.consumeSecondFactor(user, code, membership.organisation_id))) {
      await this.audit.record({
        organisationId: membership.organisation_id,
        actorType: 'user',
        actorId: user.id,
        action: 'auth.login_failed',
        ipHash: context.ipHash ?? (context.ip ? hashIp(context.ip) : null),
        metadata: { step: 'mfa' },
      });
      throw new AppError('INVALID_CODE', 'That code is not valid. Codes change every 30 seconds.');
    }

    await this.users.recordLogin(user.id);
    await this.audit.record({
      organisationId: membership.organisation_id,
      actorType: 'user',
      actorId: user.id,
      action: 'auth.login',
      ipHash: context.ipHash ?? (context.ip ? hashIp(context.ip) : null),
      metadata: { mfa: 'verified' },
    });
    return this.issueTokens(user, membership, context);
  }

  /** A TOTP code, or a recovery code, which is removed from the list when it works. */
  private async consumeSecondFactor(
    user: { id: string; mfa_secret_enc: string | null; mfa_recovery_hashes: string | null },
    code: string,
    organisationId: string,
  ): Promise<boolean> {
    const trimmed = code.trim();
    const secret = this.decryptSecret(user);
    if (secret && verifyTotp(secret, trimmed)) return true;

    if (!/^[A-Za-z0-9-]{6,20}$/.test(trimmed)) return false;
    const hash = hashToken(normaliseRecoveryCode(trimmed));
    const hashes = parseRecoveryHashes(user.mfa_recovery_hashes);
    if (!hashes.includes(hash)) return false;
    await this.users.setRecoveryHashes(
      user.id,
      hashes.filter((candidate) => candidate !== hash),
    );
    await this.audit.record({
      organisationId,
      actorType: 'user',
      actorId: user.id,
      action: 'auth.mfa_recovery_used',
      metadata: { remaining: hashes.length - 1 },
    });
    return true;
  }

  /**
   * Human-readable recovery codes: eight characters from an alphabet without `I`, `O`, `0` or `1`,
   * shown as `XXXX-XXXX`. Only the hash of the normalised form is stored, so the dashes and the
   * case somebody types do not matter.
   */
  private createRecoveryCodes(count: number): string[] {
    const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    const bytes = randomBytes(count * 8);
    return Array.from({ length: count }, (_unused, index) => {
      let raw = '';
      for (let offset = 0; offset < 8; offset += 1) {
        raw += alphabet[bytes[index * 8 + offset]! % alphabet.length];
      }
      return `${raw.slice(0, 4)}-${raw.slice(4)}`;
    });
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
   * Start a reset. Production responses never reveal account existence or return a token. Delivery
   * failures are logged without recipient, token, URL, or provider error details.
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
    if (this.mailer) {
      try {
        await this.mailer.sendPasswordReset(user.email, resetUrl);
      } catch {
        // Preserve the same public response for known and unknown addresses.
        this.logger.error('password reset email could not be sent');
      }
    } else if (this.config.NODE_ENV === 'production') {
      this.logger.warn('password reset email not sent: no mail transport is configured');
    }
    // The development-only link keeps local installations usable without a mail server.
    return this.config.NODE_ENV === 'production'
      ? { accepted: true }
      : { accepted: true, resetUrl };
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
      terms: describeTerms(user.terms_accepted_at, user.terms_version),
    };
  }

  /**
   * Accepts the current legal pack (DEC-032).
   *
   * Accounts created before the terms existed, and accounts whose pack has since been revised, land
   * here. Re-accepting the same version is allowed: it is a confirmation, not a new fact, so the
   * timestamp is refreshed and the audit entry repeated.
   */
  async acceptTerms(
    actor: AuthenticatedActor,
    context: RequestContext = {},
  ): Promise<TermsAcceptance> {
    const user = await this.users.findById(actor.userId);
    if (!user || user.disabled_at) throw new AppError('UNAUTHENTICATED', 'Account not found.');
    const acceptedAt = await this.users.recordTermsAcceptance(user.id, LEGAL_VERSION);
    await this.audit.record({
      organisationId: actor.organisationId,
      actorType: 'user',
      actorId: user.id,
      action: 'legal.terms_accepted',
      targetType: 'user',
      targetId: user.id,
      ipHash: context.ipHash ?? (context.ip ? hashIp(context.ip) : null),
      metadata: { version: LEGAL_VERSION },
    });
    return { acceptedAt, version: LEGAL_VERSION, current: true };
  }

  /** TEAM-001: invite with an expiring, single-use token; send a link when mail is configured. */
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

    const acceptUrl = `${this.config.APP_ORIGIN.replace(/\/$/, '')}/#/accept-invite?token=${encodeURIComponent(token)}`;
    if (this.mailer) {
      try {
        await this.mailer.sendInvitation(user.email, acceptUrl);
      } catch {
        // The administrator still receives the link and can share it manually.
        this.logger.error('invitation email could not be sent');
      }
    }
    return { ...toInvitation(invitation), token, acceptUrl };
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

/**
 * Describes the acceptance record against the pack that ships today (DEC-032).
 *
 * `current` is what the UI acts on: false means either "never accepted" (an account older than the
 * terms) or "accepted an earlier version", and in both cases the person is asked again.
 */
function describeTerms(acceptedAt: string | null, version: string | null): TermsAcceptance {
  return {
    acceptedAt,
    version,
    current: acceptedAt !== null && version === LEGAL_VERSION,
  };
}

/** Recovery codes are stored as a JSON array of hashes; anything else reads as "none left". */
function parseRecoveryHashes(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === 'string')
      : [];
  } catch {
    return [];
  }
}

/** Recovery codes are compared without dashes and without case. */
function normaliseRecoveryCode(code: string): string {
  return code.replace(/[^A-Za-z0-9]/g, '').toUpperCase();
}
