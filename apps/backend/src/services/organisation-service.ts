import { AppError, roleAtLeast, type Role } from '@idcp/shared';
import type { Database } from '../db/database';
import { nowIso } from '../db/database';
import {
  MembershipsRepository,
  OrganisationsRepository,
  UsersRepository,
} from '../repositories/auth-repo';
import { AuditRepository, JobsRepository } from '../repositories/system-repo';
import type { AuthenticatedActor } from './auth-service';

export class OrganisationService {
  private readonly orgs: OrganisationsRepository;
  private readonly users: UsersRepository;
  private readonly memberships: MembershipsRepository;
  private readonly audit: AuditRepository;
  private readonly jobs: JobsRepository;

  constructor(private readonly db: Database) {
    this.orgs = new OrganisationsRepository(db);
    this.users = new UsersRepository(db);
    this.memberships = new MembershipsRepository(db);
    this.audit = new AuditRepository(db);
    this.jobs = new JobsRepository(db);
  }

  async get(actor: AuthenticatedActor) {
    const organisation = await this.orgs.findById(actor.organisationId);
    if (!organisation) throw new AppError('NOT_FOUND', 'Organisation not found.');
    return {
      id: organisation.id,
      name: organisation.name,
      slug: organisation.slug,
      plan: organisation.plan,
      retentionDays: organisation.retention_days,
      aiProvider: organisation.ai_provider,
      createdAt: organisation.created_at,
    };
  }

  async update(
    actor: AuthenticatedActor,
    patch: { name?: string; retentionDays?: number; aiProvider?: 'local' | 'cloud' },
  ) {
    if (!roleAtLeast(actor.role, 'admin')) {
      throw new AppError('ROLE_REQUIRED', 'Only admins can change organisation settings.');
    }
    const updated = await this.orgs.update(actor.organisationId, {
      ...(patch.name === undefined ? {} : { name: patch.name }),
      ...(patch.retentionDays === undefined ? {} : { retention_days: patch.retentionDays }),
      ...(patch.aiProvider === undefined ? {} : { ai_provider: patch.aiProvider }),
    });
    if (!updated) throw new AppError('NOT_FOUND', 'Organisation not found.');
    await this.audit.record({
      organisationId: actor.organisationId,
      actorType: actor.actorType,
      actorId: actor.userId,
      action: 'organisation.updated',
      targetType: 'organisation',
      targetId: actor.organisationId,
      metadata: { fields: Object.keys(patch) },
    });
    return this.get(actor);
  }

  async listUsers(actor: AuthenticatedActor) {
    const members = await this.memberships.listForOrganisation(actor.organisationId);
    return members.map((member) => ({
      id: member.user_id,
      displayName: member.display_name,
      email: member.email,
      role: member.role,
      joinedAt: member.accepted_at ?? member.created_at,
    }));
  }

  async changeRole(actor: AuthenticatedActor, userId: string, role: Role) {
    if (!roleAtLeast(actor.role, 'admin')) {
      throw new AppError('ROLE_REQUIRED', 'Only admins can change roles.');
    }
    if (userId === actor.userId) {
      throw new AppError('FORBIDDEN', 'You cannot change your own role.');
    }
    if (role !== 'owner' && (await this.memberships.countOwners(actor.organisationId)) <= 1) {
      const target = await this.memberships.listForOrganisation(actor.organisationId);
      const targetMember = target.find((member) => member.user_id === userId);
      if (targetMember?.role === 'owner') {
        throw new AppError('CONFLICT', 'An organisation must keep at least one owner.');
      }
    }
    const ok = await this.memberships.updateRole(actor.organisationId, userId, role);
    if (!ok) throw new AppError('NOT_FOUND', 'That person is not a member of this organisation.');
    await this.audit.record({
      organisationId: actor.organisationId,
      actorType: actor.actorType,
      actorId: actor.userId,
      action: 'user.role_changed',
      targetType: 'user',
      targetId: userId,
      metadata: { role },
    });
    return { userId, role };
  }

  async removeUser(actor: AuthenticatedActor, userId: string) {
    if (!roleAtLeast(actor.role, 'admin')) {
      throw new AppError('ROLE_REQUIRED', 'Only admins can remove team members.');
    }
    if (userId === actor.userId) throw new AppError('FORBIDDEN', 'You cannot remove yourself.');
    const ok = await this.memberships.remove(actor.organisationId, userId);
    if (!ok) throw new AppError('NOT_FOUND', 'That person is not a member of this organisation.');
    await this.audit.record({
      organisationId: actor.organisationId,
      actorType: actor.actorType,
      actorId: actor.userId,
      action: 'user.removed',
      targetType: 'user',
      targetId: userId,
    });
  }

  async auditLogs(
    actor: AuthenticatedActor,
    filters: { action?: string; actorId?: string; from?: string; to?: string },
  ) {
    if (!roleAtLeast(actor.role, 'admin')) {
      throw new AppError('ROLE_REQUIRED', 'Only admins can read the audit log.');
    }
    const rows = await this.audit.list(actor.organisationId, filters);
    return rows.map((row) => ({
      id: row.id,
      actorType: row.actor_type,
      actorId: row.actor_id,
      action: row.action,
      targetType: row.target_type,
      targetId: row.target_id,
      metadata: JSON.parse(row.metadata) as Record<string, unknown>,
      createdAt: row.created_at,
    }));
  }

  /** Lightweight operational summary for the dashboard and for health checks. */
  async stats(actor: AuthenticatedActor) {
    const documentsByStatus = await this.db.query<{ status: string; count: number }>(
      'SELECT status, COUNT(*) AS count FROM documents WHERE organisation_id = ? AND deleted_at IS NULL GROUP BY status',
      [actor.organisationId],
    );
    const jobs = await this.jobs.countByStatus(actor.organisationId);
    return {
      organisationId: actor.organisationId,
      documents: Object.fromEntries(
        documentsByStatus.map((row) => [row.status, Number(row.count)]),
      ),
      jobs,
      generatedAt: nowIso(),
    };
  }

  /** Enqueue a retention purge (called by a scheduler or the admin endpoint). */
  async enqueueRetentionPurge(actor: AuthenticatedActor) {
    if (!roleAtLeast(actor.role, 'admin')) {
      throw new AppError('ROLE_REQUIRED', 'Only admins can run retention.');
    }
    const job = await this.jobs.enqueue({
      organisationId: actor.organisationId,
      type: 'retention_purge',
    });
    return { jobId: job.id };
  }

  async currentUserExists(userId: string): Promise<boolean> {
    return (await this.users.findById(userId)) !== null;
  }
}
