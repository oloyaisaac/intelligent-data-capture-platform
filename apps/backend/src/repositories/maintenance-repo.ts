import type { Database } from '../db/database';

/** Database operations used by the housekeeping scheduler. */
export class MaintenanceRepository {
  constructor(private readonly db: Database) {}

  organisationsWithRetention(): Promise<Array<{ id: string }>> {
    return this.db.query<{ id: string }>('SELECT id FROM organisations WHERE retention_days > 0');
  }

  findPendingPurge(organisationId: string): Promise<{ id: string } | null> {
    return this.db.one<{ id: string }>(
      `SELECT id FROM jobs
        WHERE organisation_id = ? AND type = 'retention_purge'
          AND status IN ('queued', 'running')
        LIMIT 1`,
      [organisationId],
    );
  }

  expiredExports(now: string): Promise<Array<{ id: string; storage_key: string | null }>> {
    return this.db.query<{ id: string; storage_key: string | null }>(
      `SELECT id, storage_key FROM exports
        WHERE expires_at IS NOT NULL AND expires_at <= ? AND status <> 'expired'`,
      [now],
    );
  }

  markExportExpired(id: string): Promise<void> {
    return this.db.execute(
      `UPDATE exports SET status = 'expired', storage_key = NULL WHERE id = ?`,
      [id],
    );
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
