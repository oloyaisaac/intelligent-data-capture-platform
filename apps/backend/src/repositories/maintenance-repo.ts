import type { Database } from '../db/database';
import { hasPendingErasureReference, hasStorageReference } from './storage-references';

/** Database operations used by the housekeeping scheduler. */
export class MaintenanceRepository {
  constructor(private readonly db: Database) {}

  organisationsWithRetention(): Promise<Array<{ id: string }>> {
    return this.db.query<{ id: string }>('SELECT id FROM organisations WHERE retention_days > 0');
  }

  expiredExports(
    now: string,
  ): Promise<
    Array<{ id: string; storage_key: string | null; status: string; expires_at: string }>
  > {
    return this.db.query(
      `SELECT id, storage_key, status, expires_at FROM exports
        WHERE expires_at IS NOT NULL AND expires_at <= ? AND status IN ('ready', 'failed')`,
      [now],
    );
  }

  /** Call only inside a transaction. SQLite's write transaction already serializes writers. */
  lockExport(id: string): Promise<{
    id: string;
    storage_key: string | null;
    status: string;
    expires_at: string | null;
  } | null> {
    const lock = this.db.driver === 'postgres' ? ' FOR UPDATE' : '';
    return this.db.one(
      `SELECT id, storage_key, status, expires_at FROM exports WHERE id = ?${lock}`,
      [id],
    );
  }

  async hasOtherStorageReference(exportId: string, key: string): Promise<boolean> {
    return (
      (await hasStorageReference(this.db, key, { exportId })) ||
      (await hasPendingErasureReference(this.db, key))
    );
  }

  async markExportExpired(row: {
    id: string;
    storage_key: string | null;
    status: string;
    expires_at: string;
  }): Promise<boolean> {
    const keyCondition = row.storage_key === null ? 'storage_key IS NULL' : 'storage_key = ?';
    const params = [row.id, row.status, row.expires_at];
    if (row.storage_key !== null) params.push(row.storage_key);
    const updated = await this.db.one<{ id: string }>(
      `UPDATE exports SET status = 'expired', storage_key = NULL
       WHERE id = ? AND status = ? AND expires_at = ? AND ${keyCondition} RETURNING id`,
      params,
    );
    return updated !== null;
  }

  async expirePairingSessions(now: string): Promise<number> {
    const stale = await this.db.query<{ id: string }>(
      `SELECT id FROM pairing_sessions WHERE status = 'pending' AND expires_at <= ?`,
      [now],
    );
    if (stale.length === 0) return 0;
    await this.db.execute(
      `UPDATE pairing_sessions SET status = 'expired' WHERE status = 'pending' AND expires_at <= ?`,
      [now],
    );
    return stale.length;
  }

  async deleteExpiredSessions(cutoff: string): Promise<number> {
    const rows = await this.db.query<{ id: string }>(
      'SELECT id FROM sessions WHERE expires_at < ?',
      [cutoff],
    );
    if (rows.length === 0) return 0;
    await this.db.execute('DELETE FROM sessions WHERE expires_at < ?', [cutoff]);
    return rows.length;
  }

  async deleteSpentResetTokens(cutoff: string): Promise<number> {
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
