import { newId } from '@idcp/shared/ids';
import type { Database } from '../db/database';
import { nowIso } from '../db/database';
import type { DeviceRow, PairingSessionRow } from './types';

export class DevicesRepository {
  constructor(private readonly db: Database) {}

  async create(input: {
    organisationId: string;
    userId: string;
    name: string;
    platform: 'android' | 'ios' | 'desktop';
    appVersion?: string | null;
    credentialHash: string;
  }): Promise<DeviceRow> {
    const now = nowIso();
    const row: DeviceRow = {
      id: newId(),
      organisation_id: input.organisationId,
      user_id: input.userId,
      name: input.name,
      platform: input.platform,
      app_version: input.appVersion ?? null,
      credential_hash: input.credentialHash,
      last_seen_at: now,
      revoked_at: null,
      created_at: now,
      updated_at: now,
    };
    await this.db.execute(
      `INSERT INTO devices (id, organisation_id, user_id, name, platform, app_version, credential_hash, last_seen_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        row.id,
        row.organisation_id,
        row.user_id,
        row.name,
        row.platform,
        row.app_version,
        row.credential_hash,
        row.last_seen_at,
        row.created_at,
        row.updated_at,
      ],
    );
    return row;
  }

  listForOrganisation(organisationId: string): Promise<DeviceRow[]> {
    return this.db.query<DeviceRow>(
      'SELECT * FROM devices WHERE organisation_id = ? ORDER BY created_at DESC',
      [organisationId],
    );
  }

  findById(organisationId: string, id: string): Promise<DeviceRow | null> {
    return this.db.one<DeviceRow>('SELECT * FROM devices WHERE organisation_id = ? AND id = ?', [
      organisationId,
      id,
    ]);
  }

  findByCredentialHash(hash: string): Promise<DeviceRow | null> {
    return this.db.one<DeviceRow>('SELECT * FROM devices WHERE credential_hash = ?', [hash]);
  }

  async touch(id: string): Promise<void> {
    await this.db.execute('UPDATE devices SET last_seen_at = ? WHERE id = ?', [nowIso(), id]);
  }

  async rename(organisationId: string, id: string, name: string): Promise<boolean> {
    const existing = await this.findById(organisationId, id);
    if (!existing) return false;
    await this.db.execute('UPDATE devices SET name = ?, updated_at = ? WHERE id = ?', [
      name,
      nowIso(),
      id,
    ]);
    return true;
  }

  async revoke(organisationId: string, id: string): Promise<boolean> {
    const existing = await this.findById(organisationId, id);
    if (!existing) return false;
    if (existing.revoked_at) return true;
    await this.db.execute('UPDATE devices SET revoked_at = ?, updated_at = ? WHERE id = ?', [
      nowIso(),
      nowIso(),
      id,
    ]);
    return true;
  }
}

export class PairingRepository {
  constructor(private readonly db: Database) {}

  async create(input: {
    organisationId: string;
    createdBy: string;
    tokenHash: string;
    expiresAt: string;
  }): Promise<PairingSessionRow> {
    const row: PairingSessionRow = {
      id: newId(),
      organisation_id: input.organisationId,
      created_by: input.createdBy,
      token_hash: input.tokenHash,
      status: 'pending',
      device_id: null,
      expires_at: input.expiresAt,
      completed_at: null,
      created_at: nowIso(),
    };
    await this.db.execute(
      `INSERT INTO pairing_sessions (id, organisation_id, created_by, token_hash, status, expires_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        row.id,
        row.organisation_id,
        row.created_by,
        row.token_hash,
        row.status,
        row.expires_at,
        row.created_at,
      ],
    );
    return row;
  }

  /** Call only inside the pairing transaction; SQLite's write transaction already serializes writers. */
  lockByTokenHash(hash: string): Promise<PairingSessionRow | null> {
    return this.db.one<PairingSessionRow>(
      `SELECT * FROM pairing_sessions WHERE token_hash = ?${this.db.driver === 'postgres' ? ' FOR UPDATE' : ''}`,
      [hash],
    );
  }

  findById(organisationId: string, id: string): Promise<PairingSessionRow | null> {
    return this.db.one<PairingSessionRow>(
      'SELECT * FROM pairing_sessions WHERE organisation_id = ? AND id = ?',
      [organisationId, id],
    );
  }

  /**
   * Atomically claim a pending session. Returns false when another request already claimed it,
   * which makes replaying a scanned QR code impossible.
   */
  async claim(id: string, deviceId: string): Promise<boolean> {
    const result = await this.db.one<{ id: string }>(
      `UPDATE pairing_sessions
          SET status = 'completed', device_id = ?, completed_at = ?
        WHERE id = ? AND status = 'pending'
        RETURNING id`,
      [deviceId, nowIso(), id],
    );
    return result !== null;
  }

  async expireStale(now: string = nowIso()): Promise<number> {
    const stale = await this.db.query<{ id: string }>(
      "SELECT id FROM pairing_sessions WHERE status = 'pending' AND expires_at < ?",
      [now],
    );
    if (stale.length === 0) return 0;
    await this.db.execute(
      "UPDATE pairing_sessions SET status = 'expired' WHERE status = 'pending' AND expires_at < ?",
      [now],
    );
    return stale.length;
  }
}
