import { newId } from '@idcp/shared/ids';
import type { Database } from '../db/database';
import { nowIso } from '../db/database';
import type { InvitationRow, ProjectRow } from './types';

export class ProjectsRepository {
  constructor(private readonly db: Database) {}

  async create(input: {
    organisationId: string;
    name: string;
    key: string;
    createdBy: string;
  }): Promise<ProjectRow> {
    const now = nowIso();
    const row: ProjectRow = {
      id: newId(),
      organisation_id: input.organisationId,
      name: input.name,
      key: input.key,
      created_by: input.createdBy,
      archived_at: null,
      created_at: now,
      updated_at: now,
    };
    await this.db.execute(
      `INSERT INTO projects (id, organisation_id, name, key, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        row.id,
        row.organisation_id,
        row.name,
        row.key,
        row.created_by,
        row.created_at,
        row.updated_at,
      ],
    );
    return row;
  }

  list(organisationId: string, includeArchived = false): Promise<ProjectRow[]> {
    return this.db.query<ProjectRow>(
      includeArchived
        ? 'SELECT * FROM projects WHERE organisation_id = ? ORDER BY created_at DESC'
        : 'SELECT * FROM projects WHERE organisation_id = ? AND archived_at IS NULL ORDER BY created_at DESC',
      [organisationId],
    );
  }

  findById(organisationId: string, id: string): Promise<ProjectRow | null> {
    return this.db.one<ProjectRow>('SELECT * FROM projects WHERE organisation_id = ? AND id = ?', [
      organisationId,
      id,
    ]);
  }

  findByKey(organisationId: string, key: string): Promise<ProjectRow | null> {
    return this.db.one<ProjectRow>('SELECT * FROM projects WHERE organisation_id = ? AND key = ?', [
      organisationId,
      key,
    ]);
  }

  async update(
    organisationId: string,
    id: string,
    patch: { name?: string; archived?: boolean },
  ): Promise<ProjectRow | null> {
    const current = await this.findById(organisationId, id);
    if (!current) return null;
    const next: ProjectRow = {
      ...current,
      name: patch.name ?? current.name,
      archived_at:
        patch.archived === undefined
          ? current.archived_at
          : patch.archived
            ? (current.archived_at ?? nowIso())
            : null,
      updated_at: nowIso(),
    };
    await this.db.execute(
      'UPDATE projects SET name = ?, archived_at = ?, updated_at = ? WHERE organisation_id = ? AND id = ?',
      [next.name, next.archived_at, next.updated_at, organisationId, id],
    );
    return next;
  }
}

export class InvitationsRepository {
  constructor(private readonly db: Database) {}

  async create(input: {
    organisationId: string;
    userId: string;
    email: string;
    role: string;
    tokenHash: string;
    invitedBy: string;
    expiresAt: string;
  }): Promise<InvitationRow> {
    const row: InvitationRow = {
      id: newId(),
      organisation_id: input.organisationId,
      user_id: input.userId,
      email: input.email,
      role: input.role,
      token_hash: input.tokenHash,
      invited_by: input.invitedBy,
      expires_at: input.expiresAt,
      used_at: null,
      created_at: nowIso(),
    };
    await this.db.execute(
      `INSERT INTO invitations (id, organisation_id, user_id, email, role, token_hash, invited_by, expires_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        row.id,
        row.organisation_id,
        row.user_id,
        row.email,
        row.role,
        row.token_hash,
        row.invited_by,
        row.expires_at,
        row.created_at,
      ],
    );
    return row;
  }

  findByTokenHash(tokenHash: string): Promise<InvitationRow | null> {
    return this.db.one<InvitationRow>('SELECT * FROM invitations WHERE token_hash = ?', [
      tokenHash,
    ]);
  }

  findForOrganisation(organisationId: string, id: string): Promise<InvitationRow | null> {
    return this.db.one<InvitationRow>(
      'SELECT * FROM invitations WHERE organisation_id = ? AND id = ?',
      [organisationId, id],
    );
  }

  listForOrganisation(organisationId: string): Promise<InvitationRow[]> {
    return this.db.query<InvitationRow>(
      'SELECT * FROM invitations WHERE organisation_id = ? ORDER BY created_at DESC LIMIT 100',
      [organisationId],
    );
  }

  /** Atomically consume only a still-valid invitation; safe against concurrent requests. */
  async consume(id: string, at: string): Promise<boolean> {
    const row = await this.db.one<{ id: string }>(
      'UPDATE invitations SET used_at = ? WHERE id = ? AND used_at IS NULL AND expires_at > ? RETURNING id',
      [at, id, at],
    );
    return row !== null;
  }

  async revoke(id: string): Promise<void> {
    await this.db.execute(
      'UPDATE invitations SET expires_at = ? WHERE id = ? AND used_at IS NULL',
      [nowIso(), id],
    );
  }
}
