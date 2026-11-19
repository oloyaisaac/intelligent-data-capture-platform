import type { Database } from '../db/database';

export interface EncryptedConnectorRow {
  id: string;
  organisation_id: string;
  credentials_encrypted: string;
}

export interface EncryptedMfaRow {
  id: string;
  mfa_secret_enc: string;
}

/** Offline migration access; construct with the transaction-scoped database only. */
export class EncryptionMigrationRepository {
  constructor(private readonly tx: Database) {}

  async lockForMigration(): Promise<void> {
    if (this.tx.driver === 'postgres') {
      await this.tx.execute('LOCK TABLE connectors, users, webhooks IN SHARE ROW EXCLUSIVE MODE');
    }
  }

  countWebhooks(): Promise<{ count: number | string } | null> {
    return this.tx.one<{ count: number | string }>('SELECT COUNT(*) AS count FROM webhooks');
  }

  countEnabledMfaWithoutSecret(): Promise<{ count: number | string } | null> {
    return this.tx.one<{ count: number | string }>(
      'SELECT COUNT(*) AS count FROM users WHERE mfa_enabled_at IS NOT NULL AND mfa_secret_enc IS NULL',
    );
  }

  listConnectors(): Promise<EncryptedConnectorRow[]> {
    return this.tx.query<EncryptedConnectorRow>(
      'SELECT id, organisation_id, credentials_encrypted FROM connectors WHERE credentials_encrypted IS NOT NULL ORDER BY id',
    );
  }

  listMfa(): Promise<EncryptedMfaRow[]> {
    return this.tx.query<EncryptedMfaRow>(
      'SELECT id, mfa_secret_enc FROM users WHERE mfa_secret_enc IS NOT NULL ORDER BY id',
    );
  }

  saveConnector(id: string, encrypted: string): Promise<void> {
    return this.tx.execute('UPDATE connectors SET credentials_encrypted = ? WHERE id = ?', [
      encrypted,
      id,
    ]);
  }

  saveMfa(id: string, encrypted: string): Promise<void> {
    return this.tx.execute('UPDATE users SET mfa_secret_enc = ? WHERE id = ?', [encrypted, id]);
  }
}
