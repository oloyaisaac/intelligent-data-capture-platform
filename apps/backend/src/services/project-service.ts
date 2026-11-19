import { AppError, badRequest, type Project, type Role } from '@idcp/shared';
import type { Logger } from '../logger';
import type { ProjectsRepository } from '../repositories/project-repo';
import type { AuditRepository } from '../repositories/system-repo';
import type { AuthenticatedActor } from './auth-service';
import type { ProjectRow } from '../repositories/types';

/**
 * TEAM-001 — projects inside an organisation.
 *
 * A project is a grouping label for documents and batches, not a second tenant: every query stays
 * scoped by organisation first, so a project can never widen visibility.
 */
export interface ProjectServiceRepositories {
  projects: Pick<ProjectsRepository, 'list' | 'create' | 'findById' | 'findByKey' | 'update'>;
  audit: Pick<AuditRepository, 'record'>;
}

export class ProjectService {
  private readonly projects: ProjectServiceRepositories['projects'];
  private readonly audit: ProjectServiceRepositories['audit'];

  constructor(
    repositories: ProjectServiceRepositories,
    private readonly logger: Logger,
  ) {
    this.projects = repositories.projects;
    this.audit = repositories.audit;
  }

  async list(actor: AuthenticatedActor, includeArchived = false): Promise<Project[]> {
    const rows = await this.projects.list(actor.organisationId, includeArchived);
    return rows.map(toProject);
  }

  async create(actor: AuthenticatedActor, input: { name: string; key?: string }): Promise<Project> {
    requireManager(actor.role, 'create projects');

    const key = normaliseKey(input.key ?? input.name);
    if (!/^[A-Z0-9][A-Z0-9_-]{1,19}$/.test(key)) {
      throw badRequest(
        'The project key must be 2–20 characters: letters, digits, dash or underscore.',
      );
    }
    const existing = await this.projects.findByKey(actor.organisationId, key);
    if (existing)
      throw new AppError('CONFLICT', `The key "${key}" is already used by another project.`);

    const row = await this.projects.create({
      organisationId: actor.organisationId,
      name: input.name.trim().slice(0, 120),
      key,
      createdBy: actor.userId,
    });

    await this.audit.record({
      organisationId: actor.organisationId,
      actorType: actor.actorType,
      actorId: actor.userId,
      action: 'project.created',
      targetType: 'project',
      targetId: row.id,
      metadata: { key },
    });
    this.logger.info('project created', { projectId: row.id, key });
    return toProject(row);
  }

  async update(
    actor: AuthenticatedActor,
    id: string,
    patch: { name?: string; archived?: boolean },
  ): Promise<Project> {
    requireManager(actor.role, 'change projects');
    const row = await this.projects.update(actor.organisationId, id, patch);
    if (!row) throw new AppError('NOT_FOUND', 'Project not found.');

    await this.audit.record({
      organisationId: actor.organisationId,
      actorType: actor.actorType,
      actorId: actor.userId,
      action: patch.archived === true ? 'project.archived' : 'project.updated',
      targetType: 'project',
      targetId: id,
    });
    return toProject(row);
  }

  /** Archiving keeps the documents and their project assignment; nothing is deleted. */
  async archive(actor: AuthenticatedActor, id: string): Promise<void> {
    requireManager(actor.role, 'archive projects');
    const row = await this.projects.findById(actor.organisationId, id);
    if (!row) throw new AppError('NOT_FOUND', 'Project not found.');
    await this.projects.update(actor.organisationId, id, { archived: true });
    await this.audit.record({
      organisationId: actor.organisationId,
      actorType: actor.actorType,
      actorId: actor.userId,
      action: 'project.archived',
      targetType: 'project',
      targetId: id,
    });
  }
}

function requireManager(role: Role, action: string): void {
  if (!['owner', 'admin'].includes(role)) {
    throw new AppError('ROLE_REQUIRED', `You need to be an admin to ${action}.`);
  }
}

function normaliseKey(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/[^A-Za-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toUpperCase()
    .slice(0, 20);
}

function toProject(row: ProjectRow): Project {
  return {
    id: row.id,
    name: row.name,
    key: row.key,
    archivedAt: row.archived_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
