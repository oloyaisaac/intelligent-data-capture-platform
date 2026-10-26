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
   * Claim the next runnable job. Returning the row in a single statement makes concurrent
   * workers safe: only one caller can flip `queued` → `running`.
   */
  async claimNext(now: string = nowIso()): Promise<JobRow | null> {
    return this.db.one<JobRow>(
      `UPDATE jobs SET status = 'running', started_at = ?, attempts = attempts + 1
        WHERE id = (
          SELECT id FROM jobs
           WHERE status = 'queued' AND (run_after IS NULL OR run_after <= ?)
           ORDER BY created_at LIMIT 1
        )
        RETURNING *`,
      [now, now],
    );
  }

  async markSucceeded(id: string): Promise<void> {
    await this.db.execute(
      `UPDATE jobs SET status = 'succeeded', finished_at = ?, last_error = NULL WHERE id = ?`,
      [nowIso(), id],
    );
  }

  /** Retry with exponential backoff, or mark dead once attempts are exhausted. */
  async markFailed(id: string, error: string): Promise<void> {
    const job = await this.db.one<JobRow>('SELECT * FROM jobs WHERE id = ?', [id]);
    if (!job) return;
    const exhausted = job.attempts >= job.max_attempts;
    if (exhausted) {
      await this.db.execute(
        `UPDATE jobs SET status = 'dead', finished_at = ?, last_error = ? WHERE id = ?`,
        [nowIso(), error.slice(0, 2000), id],
      );
      return;
    }
    const backoffMs = Math.min(2 ** job.attempts * 1000, 60_000);
    await this.db.execute(
      `UPDATE jobs SET status = 'queued', last_error = ?, run_after = ? WHERE id = ?`,
      [error.slice(0, 2000), new Date(Date.now() + backoffMs).toISOString(), id],
    );
  }

  findById(id: string): Promise<JobRow | null> {
    return this.db.one<JobRow>('SELECT * FROM jobs WHERE id = ?', [id]);
  }

  /**
   * Re-queue jobs that a dead process left in `running` (DEC-029).
   *
   * `claimNext` flips a job to `running` and nothing else ever moves it out of that state, so a
   * crash, a `kill -9` or a deploy that stops the container mid-extraction used to strand the job
   * — and its document in `processing` — forever. Anything claimed before this process started
   * cannot still be running here, so it is safe to retry: extraction is idempotent and `attempts`
   * already counted the lost try (DEC-008).
   *
   * Only correct for one worker process. Two instances sharing a database need a lease/heartbeat
   * instead, which is part of the multi-instance work in DEC-029.
   */
  async requeueStale(startedBefore: string): Promise<number> {
    const stale = await this.db.query<{ id: string }>(
      `SELECT id FROM jobs WHERE status = 'running' AND (started_at IS NULL OR started_at <= ?)`,
      [startedBefore],
    );
    if (stale.length === 0) return 0;
    await this.db.execute(
      `UPDATE jobs SET status = 'queued', run_after = ?, last_error = ?
        WHERE status = 'running' AND (started_at IS NULL OR started_at <= ?)`,
      [nowIso(), 'Recovered after an interrupted run (the process stopped mid-job).', startedBefore],
    );
    return stale.length;
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
    params.push(Math.min(filters.limit ?? 100, 500));
    return this.db.query<AuditLogRow>(
      `SELECT * FROM audit_logs WHERE ${clauses.join(' AND ')} ORDER BY created_at DESC LIMIT ?`,
      params,
    );
  }
}
