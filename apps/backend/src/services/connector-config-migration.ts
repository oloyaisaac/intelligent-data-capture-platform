import type { ConnectorConfigMigrationRepository } from '../repositories/connector-config-migration-repo';
import type { SecretBox } from './crypto';
import {
  decodeConnectorConfig,
  encodeConnectorConfig,
  isEncryptedConnectorConfig,
} from './connector-config';

type Records = Pick<ConnectorConfigMigrationRepository, 'lockForMigration' | 'list' | 'save'>;
export interface ConnectorConfigMigrationTransaction {
  transaction<T>(run: (records: Records) => Promise<T>): Promise<T>;
}

/** Requires all API, worker and other database writers stopped through verification and rollout. */
export async function migrateConnectorConfigs(
  transactions: ConnectorConfigMigrationTransaction,
  boxes: { read: SecretBox; target: SecretBox },
  mode: 'check' | 'apply',
): Promise<{
  mode: 'check' | 'apply';
  alreadyEncrypted: number;
  plaintext: number;
  sourceKey: number;
}> {
  return transactions.transaction(async (records) => {
    await records.lockForMigration();
    const rows = await records.list();
    const report = { mode, alreadyEncrypted: 0, plaintext: 0, sourceKey: 0 };
    const expected = new Map<string, string>();
    for (const row of rows) {
      // Validate/decrypt all rows even during check; errors roll back every write.
      const parts = decodeConnectorConfig(boxes.read, row);
      expected.set(row.id, JSON.stringify(parts));
      const config: unknown = JSON.parse(row.config);
      const encrypted = isEncryptedConnectorConfig(config);
      if (encrypted) report.alreadyEncrypted += 1;
      else report.plaintext += 1;

      let sourceKey = false;
      if (row.credentials_encrypted) {
        try {
          boxes.target.decrypt(row.credentials_encrypted, row.organisation_id);
        } catch {
          // decodeConnectorConfig above already verified the read box. This is a source-key row,
          // not an unreadable one, and must be re-encrypted before the target-only check passes.
          sourceKey = true;
          report.sourceKey += 1;
        }
      }
      if (mode === 'apply' && (!encrypted || sourceKey)) {
        const encoded = encodeConnectorConfig(boxes.target, row.organisation_id, parts);
        await records.save(row.id, encoded.config, encoded.credentialsEncrypted);
      }
    }
    if (mode === 'apply') {
      const updated = await records.list();
      if (updated.length !== rows.length) throw new Error('Migration verification failed.');
      for (const row of updated) {
        const config: unknown = JSON.parse(row.config);
        if (!isEncryptedConnectorConfig(config)) throw new Error('Migration verification failed.');
        if (JSON.stringify(decodeConnectorConfig(boxes.target, row)) !== expected.get(row.id)) {
          throw new Error('Migration verification failed.');
        }
      }
    }
    return report;
  });
}
