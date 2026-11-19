import type { Database } from '../db/database';
import type { ConnectorRow } from './types';

/** Transaction-scoped access for an offline migration. All other writers must be stopped. */
export class ConnectorConfigMigrationRepository {
  constructor(private readonly tx: Database) {}

  async lockForMigration(): Promise<void> {
    if (this.tx.driver === 'postgres') {
      await this.tx.execute('LOCK TABLE connectors IN SHARE ROW EXCLUSIVE MODE');
    }
  }

  list(): Promise<ConnectorRow[]> {
    return this.tx.query<ConnectorRow>('SELECT * FROM connectors ORDER BY id');
  }

  save(id: string, config: unknown, credentialsEncrypted: string): Promise<void> {
    return this.tx.execute(
      'UPDATE connectors SET config = ?, credentials_encrypted = ? WHERE id = ?',
      [JSON.stringify(config), credentialsEncrypted, id],
    );
  }
}
