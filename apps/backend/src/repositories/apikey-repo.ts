import { newId } from '@idcp/shared/ids';
import type { Database } from '../db/database';
import { nowIso } from '../db/database';
import type { ApiKeyRow } from './types';

export class ApiKeysRepository {
  constructor(private readonly db: Database) {}

  async create(input: {
    organisationId: string;
    name: string;
    keyHash: string;
    keyPrefix: string;
    scopes: string[];
    createdBy: string;
  }): Promise<ApiKeyRow> {
    const row: ApiKeyRow = {
      id: newId(),
      organisation_id: input.organisationId,
      name: input.name,
      key_hash: input.keyHash,
      key_prefix: input.keyPrefix,
      scopes: JSON.stringify(input.scopes),
      created_by: input.createdBy,
      last_used_at: null,
      revoked_at: null,
      created_at: nowIso(),
    };
    await this.db.execute(
      `INSERT INTO api_keys (id, organisation_id, name, key_hash, key_prefix, scopes, created_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        row.id,
        row.organisation_id,
        row.name,
        row.key_hash,
        row.key_prefix,
        row.scopes,
        row.created_by,
        row.created_at,
      ],
    );
    return row;
  }

  list(organisationId: string): Promise<ApiKeyRow[]> {
    return this.db.query<ApiKeyRow>(
      'SELECT * FROM api_keys WHERE organisation_id = ? ORDER BY created_at DESC',
      [organisationId],
    );
  }

  findById(organisationId: string, id: string): Promise<ApiKeyRow | null> {
    return this.db.one<ApiKeyRow>('SELECT * FROM api_keys WHERE organisation_id = ? AND id = ?', [
      organisationId,
      id,
    ]);
  }

  /** Lookup by hash: the plaintext key is never stored, so this is the only way back. */
  findByHash(keyHash: string): Promise<ApiKeyRow | null> {
    return this.db.one<ApiKeyRow>('SELECT * FROM api_keys WHERE key_hash = ?', [keyHash]);
  }

  async revoke(organisationId: string, id: string): Promise<ApiKeyRow | null> {
    const row = await this.findById(organisationId, id);
    if (!row) return null;
    const revokedAt = row.revoked_at ?? nowIso();
    await this.db.execute(
      'UPDATE api_keys SET revoked_at = ? WHERE organisation_id = ? AND id = ?',
      [revokedAt, organisationId, id],
    );
    return { ...row, revoked_at: revokedAt };
  }

  async touch(keyHash: string): Promise<void> {
    await this.db.execute('UPDATE api_keys SET last_used_at = ? WHERE key_hash = ?', [
      nowIso(),
      keyHash,
    ]);
  }
}
