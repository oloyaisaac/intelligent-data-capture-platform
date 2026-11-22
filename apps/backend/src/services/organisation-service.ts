import {
  AppError,
  defuseFormula,
  escapeCsvField,
  roleAtLeast,
  toCsv,
  type Role,
} from '@idcp/shared';
import { nowIso } from '../db/database';
import type {
  MembershipsRepository,
  OrganisationsRepository,
  UsersRepository,
} from '../repositories/auth-repo';
import type { AuditRepository, JobsRepository } from '../repositories/system-repo';
import type { DashboardRepository } from '../repositories/dashboard-repo';
import type { AuthenticatedActor } from './auth-service';

export interface OrganisationServiceRepositories {
  orgs: Pick<OrganisationsRepository, 'findById' | 'update'>;
  users: Pick<UsersRepository, 'findById'>;
  memberships: Pick<
    MembershipsRepository,
    'listForOrganisation' | 'countOwners' | 'updateRole' | 'remove'
  >;
  audit: Pick<AuditRepository, 'list' | 'record'>;
  jobs: Pick<JobsRepository, 'countByStatus' | 'enqueueRetentionIfAbsent'>;
  dashboard: Pick<
    DashboardRepository,
    | 'documentsByStatus'
    | 'documentsByType'
    | 'documentsByDay'
    | 'connectors'
    | 'exports'
    | 'reviewBacklog'
  >;
}

export class OrganisationService {
  private readonly orgs: OrganisationServiceRepositories['orgs'];
  private readonly users: OrganisationServiceRepositories['users'];
  private readonly memberships: OrganisationServiceRepositories['memberships'];
  private readonly audit: OrganisationServiceRepositories['audit'];
  private readonly jobs: OrganisationServiceRepositories['jobs'];
  private readonly dashboard: OrganisationServiceRepositories['dashboard'];

  constructor(repositories: OrganisationServiceRepositories) {
    this.orgs = repositories.orgs;
    this.users = repositories.users;
    this.memberships = repositories.memberships;
    this.audit = repositories.audit;
    this.jobs = repositories.jobs;
    this.dashboard = repositories.dashboard;
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
      learningOptIn: Number(organisation.learning_opt_in ?? 0) === 1,
      createdAt: organisation.created_at,
    };
  }

  async update(
    actor: AuthenticatedActor,
    patch: {
      name?: string;
      retentionDays?: number;
      aiProvider?: 'local' | 'cloud';
      learningOptIn?: boolean;
    },
  ) {
    if (!roleAtLeast(actor.role, 'admin')) {
      throw new AppError('ROLE_REQUIRED', 'Only admins can change organisation settings.');
    }
    const updated = await this.orgs.update(actor.organisationId, {
      ...(patch.name === undefined ? {} : { name: patch.name }),
      ...(patch.retentionDays === undefined ? {} : { retention_days: patch.retentionDays }),
      ...(patch.aiProvider === undefined ? {} : { ai_provider: patch.aiProvider }),
      ...(patch.learningOptIn === undefined
        ? {}
        : { learning_opt_in: patch.learningOptIn ? 1 : 0 }),
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
    filters: { action?: string; actorId?: string; from?: string; to?: string; limit?: number },
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

  /**
   * The audit trail as CSV, for the reviewer who asks "can I have it as a file?".
   *
   * Same rows, same filters, same permission as the JSON endpoint — the point is that a customer's
   * auditor can take it away, not that there is a second source of truth. Reading the whole trail is
   * itself a privileged act, so it is audited.
   */
  async auditLogsCsv(
    actor: AuthenticatedActor,
    filters: { action?: string; actorId?: string; from?: string; to?: string },
  ): Promise<string> {
    const entries = await this.auditLogs(actor, { ...filters, limit: 5_000 });
    await this.audit.record({
      organisationId: actor.organisationId,
      actorType: 'user',
      actorId: actor.userId,
      action: 'audit.exported',
      metadata: { rows: entries.length, filters },
    });
    return toCsv(
      ['created_at', 'action', 'actor_type', 'actor_id', 'target_type', 'target_id', 'metadata'],
      entries.map((entry) => [
        entry.createdAt,
        entry.action,
        entry.actorType,
        entry.actorId ?? '',
        entry.targetType ?? '',
        entry.targetId ?? '',
        JSON.stringify(entry.metadata),
      ]),
      { bom: true },
    );
  }

  /** Lightweight operational summary for the dashboard and for health checks. */
  /**
   * DASH-001: counters plus a short time series.
   *
   * ISO timestamp prefixes are grouped with SUBSTR by the repository on both database drivers.
   * The default window is 14 days, and requested windows are clamped to 90 days.
   */
  async stats(actor: AuthenticatedActor, options: { days?: number } = {}) {
    const days = clampDays(options.days);
    const documentsByStatus = await this.dashboard.documentsByStatus(actor.organisationId);
    const jobs = await this.jobs.countByStatus(actor.organisationId);
    const byType = await this.dashboard.documentsByType(actor.organisationId);
    const daily = await this.dashboard.documentsByDay(actor.organisationId, windowStart(days));
    const timeline = buildTimeline(daily, days);
    const connectors = await this.dashboard.connectors(actor.organisationId);
    const exportsRow = await this.dashboard.exports(actor.organisationId);
    const reviewBacklog = await this.dashboard.reviewBacklog(actor.organisationId);

    const documents = Object.fromEntries(
      documentsByStatus.map((row) => [row.status, Number(row.count)]),
    );
    const totalDocuments = Object.values(documents).reduce((sum, value) => sum + value, 0);

    return {
      organisationId: actor.organisationId,
      documents,
      totalDocuments,
      jobs,
      documentTypes: Object.fromEntries(
        byType.map((row) => [row.document_type, Number(row.count)]),
      ),
      timeline,
      connectors: {
        total: Number(connectors?.total ?? 0),
        active: Number(connectors?.active ?? 0),
      },
      exports: { total: Number(exportsRow?.total ?? 0), ready: Number(exportsRow?.ready ?? 0) },
      review: {
        pending: Number(reviewBacklog?.pending ?? 0),
        approved: Number(reviewBacklog?.approved ?? 0),
      },
      generatedAt: nowIso(),
    };
  }

  /** Enqueue a retention purge (called by a scheduler or the admin endpoint). */
  async enqueueRetentionPurge(actor: AuthenticatedActor) {
    if (!roleAtLeast(actor.role, 'admin')) {
      throw new AppError('ROLE_REQUIRED', 'Only admins can run retention.');
    }
    const { job } = await this.jobs.enqueueRetentionIfAbsent({
      organisationId: actor.organisationId,
    });
    if (!job) throw new AppError('NOT_FOUND', 'Organisation not found.');
    return { jobId: job.id };
  }

  async currentUserExists(userId: string): Promise<boolean> {
    return (await this.users.findById(userId)) !== null;
  }
}

/** Bounds the dashboard window: enough history to be useful, small enough to stay fast. */
export const MAX_STATS_DAYS = 90;
export const DEFAULT_STATS_DAYS = 14;

export function clampDays(value: number | undefined): number {
  if (!Number.isFinite(value) || !value) return DEFAULT_STATS_DAYS;
  return Math.min(MAX_STATS_DAYS, Math.max(1, Math.floor(value)));
}

/** Start of the dashboard window, as an ISO timestamp the stored format can compare to. */
export function windowStart(days = DEFAULT_STATS_DAYS, now: Date = new Date()): string {
  const date = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
  return `${date.toISOString().slice(0, 10)}T00:00:00.000Z`;
}

/**
 * DASH-001: the same figures as CSV, so a manager can put them in a spreadsheet without a tool.
 * Rendered from the stats object rather than a second query: one code path, one set of numbers.
 */
export function statsToCsv(stats: Awaited<ReturnType<OrganisationService['stats']>>): string {
  const rows: string[][] = [['date', 'uploaded', 'approved', 'failed']];
  for (const point of stats.timeline) {
    rows.push([point.date, String(point.uploaded), String(point.approved), String(point.failed)]);
  }
  rows.push([]);
  rows.push(['metric', 'value']);
  rows.push(['total_documents', String(stats.totalDocuments)]);
  for (const [status, count] of Object.entries(stats.documents).sort()) {
    rows.push([`status:${status}`, String(count)]);
  }
  for (const [type, count] of Object.entries(stats.documentTypes).sort()) {
    rows.push([`type:${type}`, String(count)]);
  }
  rows.push(['review_pending', String(stats.review.pending)]);
  rows.push(['review_approved', String(stats.review.approved)]);
  rows.push(['connectors_active', String(stats.connectors.active)]);
  rows.push(['exports_ready', String(stats.exports.ready)]);

  return `\uFEFF${rows
    .map((row) => row.map((cell) => escapeCsvField(defuseFormula(cell))).join(','))
    .join('\r\n')}\r\n`;
}

/**
 * Fills the gaps: a day with no documents still appears in the series, so the chart does not lie
 * about a quiet Sunday by omitting it.
 */
export function buildTimeline(
  rows: Array<{ day: string; status: string; count: number }>,
  days = 14,
  now: Date = new Date(),
): Array<{ date: string; uploaded: number; approved: number; failed: number }> {
  const buckets = new Map<string, { uploaded: number; approved: number; failed: number }>();
  for (let index = days - 1; index >= 0; index -= 1) {
    const date = new Date(now.getTime() - index * 24 * 60 * 60 * 1000);
    buckets.set(date.toISOString().slice(0, 10), { uploaded: 0, approved: 0, failed: 0 });
  }

  for (const row of rows) {
    const bucket = buckets.get(String(row.day).slice(0, 10));
    if (!bucket) continue;
    bucket.uploaded += Number(row.count);
    if (row.status === 'approved') bucket.approved += Number(row.count);
    if (row.status === 'failed') bucket.failed += Number(row.count);
  }

  return [...buckets.entries()].map(([date, counts]) => ({ date, ...counts }));
}
