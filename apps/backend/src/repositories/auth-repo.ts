import type { Role } from '@idcp/shared';
import { newId } from '@idcp/shared/ids';
import type { Database } from '../db/database';
import { nowIso } from '../db/database';
import type {
  MembershipRow,
  OrganisationRow,
  PasswordResetRow,
  SessionRow,
  UserRow,
} from './types';

export class OrganisationsRepository {
  constructor(private readonly db: Database) {}

  async create(input: { name: string; slug: string; plan?: string }): Promise<OrganisationRow> {
    const row: OrganisationRow = {
      id: newId(),
      name: input.name,
      slug: input.slug,
      plan: input.plan ?? 'free',
      retention_days: 90,
      ai_provider: 'local',
      learning_opt_in: 0,
      settings: '{}',
      created_at: nowIso(),
      updated_at: nowIso(),
    };
    await this.db.execute(
      `INSERT INTO organisations (id, name, slug, plan, retention_days, ai_provider, learning_opt_in, settings, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        row.id,
        row.name,
        row.slug,
        row.plan,
        row.retention_days,
        row.ai_provider,
        row.learning_opt_in,
        row.settings,
        row.created_at,
        row.updated_at,
      ],
    );
    return row;
  }

  findById(id: string): Promise<OrganisationRow | null> {
    return this.db.one<OrganisationRow>('SELECT * FROM organisations WHERE id = ?', [id]);
  }

  findBySlug(slug: string): Promise<OrganisationRow | null> {
    return this.db.one<OrganisationRow>('SELECT * FROM organisations WHERE slug = ?', [slug]);
  }

  async update(
    id: string,
    patch: Partial<
      Pick<OrganisationRow, 'name' | 'retention_days' | 'ai_provider' | 'plan' | 'learning_opt_in'>
    >,
  ): Promise<OrganisationRow | null> {
    const current = await this.findById(id);
    if (!current) return null;
    const next = { ...current, ...patch, updated_at: nowIso() };
    await this.db.execute(
      `UPDATE organisations SET name = ?, plan = ?, retention_days = ?, ai_provider = ?,
        learning_opt_in = ?, updated_at = ? WHERE id = ?`,
      [
        next.name,
        next.plan,
        next.retention_days,
        next.ai_provider,
        next.learning_opt_in,
        next.updated_at,
        id,
      ],
    );
    return next;
  }
}

export class UsersRepository {
  constructor(private readonly db: Database) {}

  async create(input: {
    email: string;
    passwordHash: string | null;
    displayName: string;
    locale?: string;
    /** Set together with the password at sign-up or invitation acceptance (DEC-032). */
    termsAcceptedAt?: string | null;
    termsVersion?: string | null;
  }): Promise<UserRow> {
    const row: UserRow = {
      id: newId(),
      email: input.email.toLowerCase(),
      password_hash: input.passwordHash,
      display_name: input.displayName,
      locale: input.locale ?? 'en',
      email_verified_at: null,
      last_login_at: null,
      disabled_at: null,
      terms_accepted_at: input.termsAcceptedAt ?? null,
      terms_version: input.termsVersion ?? null,
      created_at: nowIso(),
      updated_at: nowIso(),
    };
    await this.db.execute(
      `INSERT INTO users (id, email, password_hash, display_name, locale, terms_accepted_at, terms_version, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        row.id,
        row.email,
        row.password_hash,
        row.display_name,
        row.locale,
        row.terms_accepted_at,
        row.terms_version,
        row.created_at,
        row.updated_at,
      ],
    );
    return row;
  }

  findById(id: string): Promise<UserRow | null> {
    return this.db.one<UserRow>('SELECT * FROM users WHERE id = ?', [id]);
  }

  findByEmail(email: string): Promise<UserRow | null> {
    return this.db.one<UserRow>('SELECT * FROM users WHERE email = ?', [email.toLowerCase()]);
  }

  async recordLogin(id: string): Promise<void> {
    await this.db.execute('UPDATE users SET last_login_at = ?, updated_at = ? WHERE id = ?', [
      nowIso(),
      nowIso(),
      id,
    ]);
  }

  async setPassword(id: string, passwordHash: string): Promise<void> {
    await this.db.execute('UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?', [
      passwordHash,
      nowIso(),
      id,
    ]);
  }

  /** Records acceptance of the current legal pack and returns the timestamp used (DEC-032). */
  async recordTermsAcceptance(id: string, version: string): Promise<string> {
    const acceptedAt = nowIso();
    await this.db.execute(
      'UPDATE users SET terms_accepted_at = ?, terms_version = ?, updated_at = ? WHERE id = ?',
      [acceptedAt, version, acceptedAt, id],
    );
    return acceptedAt;
  }

  /**
   * Erase the personal data on an account while keeping the row, so the audit trail and any
   * organisation records that reference it stay intact (privacy policy §7, GDPR art. 17(3)).
   * The address is replaced with a unique, undeliverable placeholder: re-registering the old
   * address later must work.
   */
  async anonymise(id: string): Promise<void> {
    await this.db.execute(
      `UPDATE users
          SET email = ?, display_name = ?, password_hash = NULL, disabled_at = ?, updated_at = ?
        WHERE id = ?`,
      [`deleted-${id}@erased.invalid`, 'Erased account', nowIso(), nowIso(), id],
    );
  }
}

/** Single-use, hashed password-reset tokens (DEC-030). */
export class PasswordResetsRepository {
  constructor(private readonly db: Database) {}

  async create(input: {
    userId: string;
    tokenHash: string;
    expiresAt: string;
  }): Promise<PasswordResetRow> {
    const row: PasswordResetRow = {
      id: newId(),
      user_id: input.userId,
      token_hash: input.tokenHash,
      expires_at: input.expiresAt,
      used_at: null,
      created_at: nowIso(),
    };
    await this.db.execute(
      `INSERT INTO password_resets (id, user_id, token_hash, expires_at, created_at)
       VALUES (?, ?, ?, ?, ?)`,
      [row.id, row.user_id, row.token_hash, row.expires_at, row.created_at],
    );
    return row;
  }

  findByTokenHash(tokenHash: string): Promise<PasswordResetRow | null> {
    return this.db.one<PasswordResetRow>('SELECT * FROM password_resets WHERE token_hash = ?', [
      tokenHash,
    ]);
  }

  /**
   * Mark a token used. Returns false when another request already consumed it, which is what makes
   * the reset single-use even under two concurrent submissions.
   */
  async markUsed(id: string): Promise<boolean> {
    const before = await this.db.one<{ used_at: string | null }>(
      'SELECT used_at FROM password_resets WHERE id = ?',
      [id],
    );
    if (!before || before.used_at) return false;
    await this.db.execute(
      'UPDATE password_resets SET used_at = ? WHERE id = ? AND used_at IS NULL',
      [nowIso(), id],
    );
    const after = await this.db.one<{ used_at: string | null }>(
      'SELECT used_at FROM password_resets WHERE id = ?',
      [id],
    );
    return Boolean(after?.used_at);
  }

  /** Invalidate every outstanding token for a person (a new request or a completed reset). */
  async invalidateOutstanding(userId: string): Promise<void> {
    await this.db.execute(
      'UPDATE password_resets SET used_at = ? WHERE user_id = ? AND used_at IS NULL',
      [nowIso(), userId],
    );
  }

  async deleteUsedBefore(cutoff: string): Promise<number> {
    const rows = await this.db.query<{ id: string }>(
      'SELECT id FROM password_resets WHERE used_at IS NOT NULL AND used_at < ?',
      [cutoff],
    );
    if (rows.length === 0) return 0;
    await this.db.execute('DELETE FROM password_resets WHERE used_at IS NOT NULL AND used_at < ?', [
      cutoff,
    ]);
    return rows.length;
  }
}

export interface MembershipWithUser extends MembershipRow {
  display_name: string;
  email: string;
}

export class MembershipsRepository {
  constructor(private readonly db: Database) {}

  async create(input: {
    organisationId: string;
    userId: string;
    role: Role;
    invitedBy?: string;
    accepted?: boolean;
  }): Promise<MembershipRow> {
    const now = nowIso();
    const row: MembershipRow = {
      id: newId(),
      organisation_id: input.organisationId,
      user_id: input.userId,
      role: input.role,
      invited_by: input.invitedBy ?? null,
      accepted_at: input.accepted === false ? null : now,
      created_at: now,
      updated_at: now,
    };
    await this.db.execute(
      `INSERT INTO memberships (id, organisation_id, user_id, role, invited_by, accepted_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        row.id,
        row.organisation_id,
        row.user_id,
        row.role,
        row.invited_by,
        row.accepted_at,
        row.created_at,
        row.updated_at,
      ],
    );
    return row;
  }

  findForUser(userId: string): Promise<MembershipRow | null> {
    return this.db.one<MembershipRow>(
      'SELECT * FROM memberships WHERE user_id = ? ORDER BY created_at LIMIT 1',
      [userId],
    );
  }

  async listForOrganisation(organisationId: string): Promise<MembershipWithUser[]> {
    return this.db.query<MembershipWithUser>(
      `SELECT m.*, u.display_name, u.email
         FROM memberships m JOIN users u ON u.id = m.user_id
        WHERE m.organisation_id = ?
        ORDER BY m.created_at`,
      [organisationId],
    );
  }

  async updateRole(organisationId: string, userId: string, role: Role): Promise<boolean> {
    const existing = await this.db.one<MembershipRow>(
      'SELECT * FROM memberships WHERE organisation_id = ? AND user_id = ?',
      [organisationId, userId],
    );
    if (!existing) return false;
    await this.db.execute(
      'UPDATE memberships SET role = ?, updated_at = ? WHERE organisation_id = ? AND user_id = ?',
      [role, nowIso(), organisationId, userId],
    );
    return true;
  }

  async remove(organisationId: string, userId: string): Promise<boolean> {
    const existing = await this.db.one<MembershipRow>(
      'SELECT * FROM memberships WHERE organisation_id = ? AND user_id = ?',
      [organisationId, userId],
    );
    if (!existing) return false;
    await this.db.execute('DELETE FROM memberships WHERE organisation_id = ? AND user_id = ?', [
      organisationId,
      userId,
    ]);
    return true;
  }

  async countOwners(organisationId: string): Promise<number> {
    const row = await this.db.one<{ count: number }>(
      "SELECT COUNT(*) AS count FROM memberships WHERE organisation_id = ? AND role = 'owner'",
      [organisationId],
    );
    return Number(row?.count ?? 0);
  }
}

export class SessionsRepository {
  constructor(private readonly db: Database) {}

  async create(input: {
    userId: string;
    organisationId: string;
    refreshTokenHash: string;
    expiresAt: string;
    userAgent?: string | null;
    ipHash?: string | null;
  }): Promise<SessionRow> {
    const row: SessionRow = {
      id: newId(),
      user_id: input.userId,
      organisation_id: input.organisationId,
      refresh_token_hash: input.refreshTokenHash,
      user_agent: input.userAgent ?? null,
      ip_hash: input.ipHash ?? null,
      expires_at: input.expiresAt,
      revoked_at: null,
      created_at: nowIso(),
    };
    await this.db.execute(
      `INSERT INTO sessions (id, user_id, organisation_id, refresh_token_hash, user_agent, ip_hash, expires_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        row.id,
        row.user_id,
        row.organisation_id,
        row.refresh_token_hash,
        row.user_agent,
        row.ip_hash,
        row.expires_at,
        row.created_at,
      ],
    );
    return row;
  }

  findByTokenHash(hash: string): Promise<SessionRow | null> {
    return this.db.one<SessionRow>('SELECT * FROM sessions WHERE refresh_token_hash = ?', [hash]);
  }

  async revoke(id: string): Promise<void> {
    await this.db.execute(
      'UPDATE sessions SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL',
      [nowIso(), id],
    );
  }

  async revokeAllForUser(userId: string, exceptId?: string): Promise<number> {
    const rows = await this.db.query<{ id: string }>(
      exceptId
        ? 'SELECT id FROM sessions WHERE user_id = ? AND revoked_at IS NULL AND id <> ?'
        : 'SELECT id FROM sessions WHERE user_id = ? AND revoked_at IS NULL',
      exceptId ? [userId, exceptId] : [userId],
    );
    if (rows.length === 0) return 0;
    await this.db.execute(
      exceptId
        ? 'UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL AND id <> ?'
        : 'UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL',
      exceptId ? [nowIso(), userId, exceptId] : [nowIso(), userId],
    );
    return rows.length;
  }

  /** Live sessions for the account screen: newest first, revoked and expired rows omitted. */
  listForUser(userId: string, now: string = nowIso()): Promise<SessionRow[]> {
    return this.db.query<SessionRow>(
      `SELECT * FROM sessions
        WHERE user_id = ? AND revoked_at IS NULL AND expires_at > ?
        ORDER BY created_at DESC`,
      [userId, now],
    );
  }

  findByIdForUser(userId: string, id: string): Promise<SessionRow | null> {
    return this.db.one<SessionRow>('SELECT * FROM sessions WHERE id = ? AND user_id = ?', [
      id,
      userId,
    ]);
  }

  /** Housekeeping: drop sessions that expired long ago (they can never be used again). */
  async deleteExpiredBefore(cutoff: string): Promise<number> {
    const rows = await this.db.query<{ id: string }>(
      'SELECT id FROM sessions WHERE expires_at < ?',
      [cutoff],
    );
    if (rows.length === 0) return 0;
    await this.db.execute('DELETE FROM sessions WHERE expires_at < ?', [cutoff]);
    return rows.length;
  }
}
