import { newId } from '@idcp/shared/ids';
import type { Database } from '../db/database';
import { nowIso } from '../db/database';
import type { AuditLogRow, JobRow } from './types';

export class JobsRepository {
  constructor(private readonly db: Database) {}

  async enqueue(input: {
    organisationId: string;
    type: string;
    documentId?: string | null;
    payload?: unknown;
    maxAttempts?: number;
    runAfter?: string;
  }): Promise<JobRow> {
    const row: JobRow = {
      id: newId(),
      organisation_id: input.organisationId,
      type: input.type,
      document_id: input.documentId ?? null,
      payload: JSON.stringify(input.payload ?? {}),
      status: 'queued',
      attempts: 0,
      max_attempts: input.maxAttempts ?? 5,
      last_error: null,
      run_after: input.runAfter ?? nowIso(),
      started_at: null,
      finished_at: null,
      created_at: nowIso(),
    };
    await this.db.execute(
      `INSERT INTO jobs (id, organisation_id, type, document_id, payload, status, attempts, max_attempts, run_after, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        row.id,
        row.organisation_id,
        row.type,
        row.document_id,
        row.payload,
        row.status,
        row.attempts,
        row.max_attempts,
        row.run_after,
        row.created_at,
      ],
    );
    return row;
  }

  /**
   * Claim one runnable job. Extraction jobs for the same document serialize on its row; after
   * taking that lock, recheck for another running extraction before claiming. The queued/runnable
   * predicate is rechecked on update because a competing claimant can select the same row.
   * This does not make retries, crash recovery or external effects exactly-once.
   */
  async claimNext(now: string = nowIso()): Promise<JobRow | null> {
    return this.db.transaction(async (tx) => {
      // Job before document matches the worker's publication/failure lock order. SKIP LOCKED
      // allows other jobs to make progress instead of waiting behind a busy candidate.
      const candidateLock = tx.driver === 'postgres' ? ' FOR UPDATE OF j SKIP LOCKED' : '';
      const candidate = await tx.one<JobRow>(
        `SELECT j.* FROM jobs j
         WHERE j.status = 'queued' AND (j.run_after IS NULL OR j.run_after <= ?)
           AND (j.type <> 'extract_document' OR j.document_id IS NULL OR NOT EXISTS (
             SELECT 1 FROM jobs active WHERE active.organisation_id = j.organisation_id
               AND active.document_id = j.document_id AND active.type = 'extract_document'
               AND active.status = 'running'
           ))
         ORDER BY j.created_at, j.id LIMIT 1${candidateLock}`,
        [now],
      );
      if (!candidate) return null;
      if (candidate.type === 'extract_document' && candidate.document_id) {
        const lock = tx.driver === 'postgres' ? ' FOR UPDATE' : '';
        // SQLite's transaction already owns the write lock. PostgreSQL row locking serializes
        // different queued jobs for the same existing document across worker processes.
        await tx.one(`SELECT id FROM documents WHERE organisation_id = ? AND id = ?${lock}`, [
          candidate.organisation_id,
          candidate.document_id,
        ]);
        const running = await tx.one<{ id: string }>(
          `SELECT id FROM jobs WHERE organisation_id = ? AND document_id = ?
           AND type = 'extract_document' AND status = 'running' LIMIT 1`,
          [candidate.organisation_id, candidate.document_id],
        );
        if (running) return null;
      }
      return tx.one<JobRow>(
        `UPDATE jobs SET status = 'running', started_at = ?, attempts = attempts + 1
         WHERE id = ? AND status = 'queued' AND (run_after IS NULL OR run_after <= ?)
         RETURNING *`,
        [now, candidate.id, now],
      );
    });
  }

  /** Lock and validate a claim inside a transaction, serialising against recovery on PostgreSQL. */
  async lockRunning(id: string, attempt: number): Promise<boolean> {
    const lock = this.db.driver === 'postgres' ? ' FOR UPDATE' : '';
    const row = await this.db.one<{ id: string }>(
      `SELECT id FROM jobs WHERE id = ? AND status = 'running' AND attempts = ?${lock}`,
      [id, attempt],
    );
    return row !== null;
  }

  /** Guard the job row against completion by a claim that has been recovered or replaced. */
  async markSucceeded(id: string, attempt: number): Promise<boolean> {
    const updated = await this.db.one<{ id: string }>(
      `UPDATE jobs SET status = 'succeeded', finished_at = ?, last_error = NULL
       WHERE id = ? AND status = 'running' AND attempts = ? RETURNING id`,
      [nowIso(), id, attempt],
    );
    return updated !== null;
  }

  /** Retry with exponential backoff, or mark dead once attempts are exhausted. */
  async markFailed(id: string, attempt: number, error: string): Promise<'dead' | 'queued' | null> {
    const job = await this.db.one<JobRow>(
      `SELECT * FROM jobs WHERE id = ? AND status = 'running' AND attempts = ?`,
      [id, attempt],
    );
    if (!job) return null;
    const exhausted = job.attempts >= job.max_attempts;
    const backoffMs = Math.min(2 ** job.attempts * 1000, 60_000);
    // The guarded update is essential even after the read: recovery or another worker may have
    // changed the row in between. This fences only this row, not the job's other side effects.
    const updated = await this.db.one<{ id: string }>(
      `UPDATE jobs SET status = ?, finished_at = ?, last_error = ?, run_after = ?
       WHERE id = ? AND status = 'running' AND attempts = ? RETURNING id`,
      [
        exhausted ? 'dead' : 'queued',
        exhausted ? nowIso() : null,
        error.slice(0, 2000),
        exhausted ? job.run_after : new Date(Date.now() + backoffMs).toISOString(),
        id,
        attempt,
      ],
    );
    return updated ? (exhausted ? 'dead' : 'queued') : null;
  }

  findById(id: string): Promise<JobRow | null> {
    return this.db.one<JobRow>('SELECT * FROM jobs WHERE id = ?', [id]);
  }

  async countRunning(): Promise<number> {
    const row = await this.db.one<{ count: number | string }>(
      "SELECT COUNT(*) AS count FROM jobs WHERE status = 'running'",
    );
    return Number(row?.count ?? 0);
  }

  /** Limited metadata for an offline operator; never include payload or error text. */
  listRunningForRecovery(): Promise<
    Array<
      Pick<JobRow, 'id' | 'organisation_id' | 'document_id' | 'type' | 'attempts' | 'started_at'>
    >
  > {
    return this.db.query(
      `SELECT id, organisation_id, document_id, type, attempts, started_at
       FROM jobs WHERE status = 'running' ORDER BY created_at, id LIMIT 1000`,
    );
  }

  /**
   * Operator-directed recovery only, after all workers are stopped and external effects reviewed.
   * Neither the attempt guard nor a database transaction proves a previous process is dead.
   */
  async requeueInterrupted(id: string, attempt: number): Promise<boolean> {
    const row = await this.db.one<{ id: string }>(
      `UPDATE jobs SET status = 'queued', run_after = ?, last_error = ?
       WHERE id = ? AND status = 'running' AND attempts = ? RETURNING id`,
      [nowIso(), 'Requeued by operator after offline review.', id, attempt],
    );
    return row !== null;
  }

  /** Check after locking the document; reprocess enqueues under that same document lock. */
  async hasActiveExtraction(organisationId: string, documentId: string): Promise<boolean> {
    const row = await this.db.one<{ id: string }>(
      `SELECT id FROM jobs WHERE organisation_id = ? AND document_id = ?
       AND type = 'extract_document' AND status IN ('queued', 'running') LIMIT 1`,
      [organisationId, documentId],
    );
    return row !== null;
  }

  /** The most recent extraction job for a prior upload, without enqueueing new work. */
  latestExtractionForDocument(organisationId: string, documentId: string): Promise<JobRow | null> {
    return this.db.one<JobRow>(
      `SELECT * FROM jobs WHERE organisation_id = ? AND document_id = ? AND type = 'extract_document'
       ORDER BY created_at DESC, id DESC LIMIT 1`,
      [organisationId, documentId],
    );
  }

  listForDocument(documentId: string): Promise<JobRow[]> {
    return this.db.query<JobRow>('SELECT * FROM jobs WHERE document_id = ? ORDER BY created_at', [
      documentId,
    ]);
  }

  async countByStatus(organisationId: string): Promise<Record<string, number>> {
    const rows = await this.db.query<{ status: string; count: number }>(
      'SELECT status, COUNT(*) AS count FROM jobs WHERE organisation_id = ? GROUP BY status',
      [organisationId],
    );
    return Object.fromEntries(rows.map((row) => [row.status, Number(row.count)]));
  }
}

export class AuditRepository {
  constructor(private readonly db: Database) {}

  async record(input: {
    organisationId: string;
    actorType: 'user' | 'device' | 'system' | 'api_key';
    actorId?: string | null;
    action: string;
    targetType?: string | null;
    targetId?: string | null;
    ipHash?: string | null;
    metadata?: Record<string, unknown>;
  }): Promise<void> {
    await this.db.execute(
      `INSERT INTO audit_logs (id, organisation_id, actor_type, actor_id, action, target_type, target_id, ip_hash, metadata, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        newId(),
        input.organisationId,
        input.actorType,
        input.actorId ?? null,
        input.action,
        input.targetType ?? null,
        input.targetId ?? null,
        input.ipHash ?? null,
        JSON.stringify(input.metadata ?? {}),
        nowIso(),
      ],
    );
  }

  async list(
    organisationId: string,
    filters: { action?: string; actorId?: string; from?: string; to?: string; limit?: number } = {},
  ): Promise<AuditLogRow[]> {
    const clauses = ['organisation_id = ?'];
    const params: unknown[] = [organisationId];
    if (filters.action) {
      clauses.push('action = ?');
      params.push(filters.action);
    }
    if (filters.actorId) {
      clauses.push('actor_id = ?');
      params.push(filters.actorId);
    }
    if (filters.from) {
      clauses.push('created_at >= ?');
      params.push(filters.from);
    }
    if (filters.to) {
      clauses.push('created_at <= ?');
      params.push(filters.to);
    }
    // 500 is the page size the UI asks for; the CSV export asks for more, up to 5,000.
    params.push(Math.min(filters.limit ?? 100, 5_000));
    return this.db.query<AuditLogRow>(
      `SELECT * FROM audit_logs WHERE ${clauses.join(' AND ')} ORDER BY created_at DESC LIMIT ?`,
      params,
    );
  }
}
