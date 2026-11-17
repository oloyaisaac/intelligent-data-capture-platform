import { AppError, escapeCsvField, roleAtLeast, toCsv, type Role } from '@idcp/shared';
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
   * `date(created_at)` is the one date-truncation expression both SQLite and PostgreSQL accept, so
   * the same query runs on the dev and production drivers. The window is bounded (14 days) so the
   * dashboard cannot turn into a table scan as history grows.
   */
  async stats(actor: AuthenticatedActor, options: { days?: number } = {}) {
    const days = clampDays(options.days);
    const documentsByStatus = await this.db.query<{ status: string; count: number }>(
      'SELECT status, COUNT(*) AS count FROM documents WHERE organisation_id = ? AND deleted_at IS NULL GROUP BY status',
      [actor.organisationId],
    );
    const jobs = await this.jobs.countByStatus(actor.organisationId);

    const byType = await this.db.query<{ document_type: string; count: number }>(
      `SELECT document_type, COUNT(*) AS count FROM documents
        WHERE organisation_id = ? AND deleted_at IS NULL
        GROUP BY document_type ORDER BY count DESC`,
      [actor.organisationId],
    );

    const daily = await this.db.query<{ day: string; status: string; count: number }>(
      `SELECT SUBSTR(created_at, 1, 10) AS day, status, COUNT(*) AS count FROM documents
        WHERE organisation_id = ? AND deleted_at IS NULL AND created_at >= ?
        GROUP BY SUBSTR(created_at, 1, 10), status ORDER BY day`,
      [actor.organisationId, windowStart(days)],
    );

    const timeline = buildTimeline(daily, days);

    const connectors = await this.db.one<{ total: number; active: number }>(
      `SELECT COUNT(*) AS total,
              SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END) AS active
         FROM connectors WHERE organisation_id = ?`,
      [actor.organisationId],
    );

    const exportsRow = await this.db.one<{ total: number; ready: number }>(
      `SELECT COUNT(*) AS total, SUM(CASE WHEN status = 'ready' THEN 1 ELSE 0 END) AS ready
         FROM exports WHERE organisation_id = ?`,
      [actor.organisationId],
    );

    const reviewBacklog = await this.db.one<{ pending: number; approved: number }>(
      `SELECT
         SUM(CASE WHEN status = 'needs_review' THEN 1 ELSE 0 END) AS pending,
         SUM(CASE WHEN status = 'approved' THEN 1 ELSE 0 END) AS approved
       FROM documents WHERE organisation_id = ? AND deleted_at IS NULL`,
      [actor.organisationId],
    );

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
    .map((row) => row.map((cell) => escapeCsvField(cell)).join(','))
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
