import type { Database } from '../db/database';
import { createSecretBox, type SecretBox } from './crypto';

export interface EncryptionMigrationReport {
  mode: 'check' | 'apply';
  connectors: { alreadyCurrent: number; legacy: number };
  mfa: { alreadyCurrent: number; legacy: number };
}

/**
 * Re-encrypt legacy records in a single transaction, or inspect them without writing. The caller
 * MUST stop all application processes and other database writers before either operation and keep
 * them stopped through post-migration verification and configuration rollout.
 */
export async function migrateEncryptionKeys(
  db: Database,
  input: { encryptionSecret: string; sourceSecret: string; mode: 'check' | 'apply' },
): Promise<EncryptionMigrationReport> {
  if (input.encryptionSecret === input.sourceSecret) {
    throw new Error('The target encryption key and migration source key must differ.');
  }
  const target = createSecretBox(input.encryptionSecret);
  const source = createSecretBox(input.sourceSecret);
  const report: EncryptionMigrationReport = {
    mode: input.mode,
    connectors: { alreadyCurrent: 0, legacy: 0 },
    mfa: { alreadyCurrent: 0, legacy: 0 },
  };

  return db.transaction(async (tx) => {
    // Row locks alone cannot prevent newly inserted rows. This protects the scan during the
    // transaction, but cannot prevent an old process writing after commit: downtime is still required.
    if (tx.driver === 'postgres') {
      await tx.execute('LOCK TABLE connectors, users, webhooks IN SHARE ROW EXCLUSIVE MODE');
    }
    const webhooks = await tx.one<{ count: number | string }>(
      'SELECT COUNT(*) AS count FROM webhooks',
    );
    if (Number(webhooks?.count ?? 0) !== 0) {
      throw new Error(
        'Webhook secrets are not supported by this migration. Resolve webhook records before rotating keys.',
      );
    }
    const missingMfa = await tx.one<{ count: number | string }>(
      'SELECT COUNT(*) AS count FROM users WHERE mfa_enabled_at IS NOT NULL AND mfa_secret_enc IS NULL',
    );
    if (Number(missingMfa?.count ?? 0) !== 0) {
      throw new Error(
        'An enabled MFA account has no stored secret. Investigate before rotating keys.',
      );
    }
    const connectors = await tx.query<{
      id: string;
      organisation_id: string;
      credentials_encrypted: string;
    }>(
      'SELECT id, organisation_id, credentials_encrypted FROM connectors WHERE credentials_encrypted IS NOT NULL ORDER BY id',
    );
    const users = await tx.query<{ id: string; mfa_secret_enc: string }>(
      'SELECT id, mfa_secret_enc FROM users WHERE mfa_secret_enc IS NOT NULL ORDER BY id',
    );

    async function handle(
      payload: string,
      context: string,
      counters: { alreadyCurrent: number; legacy: number },
      save: (value: string) => Promise<void>,
    ): Promise<void> {
      if (canDecrypt(target, payload, context)) {
        counters.alreadyCurrent += 1;
        return;
      }
      let plaintext: string;
      try {
        plaintext = source.decrypt(payload, context);
      } catch {
        // Do not log ciphertext, context, row identifiers, key material or the provider error.
        throw new Error(
          'An encrypted record cannot be decrypted with the target or source key. No migration was committed.',
        );
      }
      counters.legacy += 1;
      if (input.mode === 'apply') {
        const encrypted = target.encrypt(plaintext, context);
        // Confirm the target can decrypt the freshly encrypted value before writing it.
        if (target.decrypt(encrypted, context) !== plaintext)
          throw new Error('Encryption verification failed. No migration was committed.');
        await save(encrypted);
      }
    }

    for (const row of connectors) {
      await handle(
        row.credentials_encrypted,
        row.organisation_id,
        report.connectors,
        async (encrypted) => {
          await tx.execute('UPDATE connectors SET credentials_encrypted = ? WHERE id = ?', [
            encrypted,
            row.id,
          ]);
        },
      );
    }
    for (const row of users) {
      await handle(row.mfa_secret_enc, `mfa:${row.id}`, report.mfa, async (encrypted) => {
        await tx.execute('UPDATE users SET mfa_secret_enc = ? WHERE id = ?', [encrypted, row.id]);
      });
    }

    if (input.mode === 'apply') {
      // Check persisted rows using only the target key before the transaction commits.
      const updatedConnectors = await tx.query<{
        organisation_id: string;
        credentials_encrypted: string;
      }>(
        'SELECT organisation_id, credentials_encrypted FROM connectors WHERE credentials_encrypted IS NOT NULL',
      );
      const updatedUsers = await tx.query<{ id: string; mfa_secret_enc: string }>(
        'SELECT id, mfa_secret_enc FROM users WHERE mfa_secret_enc IS NOT NULL',
      );
      if (
        updatedConnectors.length !== connectors.length ||
        updatedUsers.length !== users.length ||
        updatedConnectors.some(
          (row) => !canDecrypt(target, row.credentials_encrypted, row.organisation_id),
        ) ||
        updatedUsers.some((row) => !canDecrypt(target, row.mfa_secret_enc, `mfa:${row.id}`))
      ) {
        throw new Error('Post-migration verification failed. No migration was committed.');
      }
    }
    return report;
  });
}

function canDecrypt(box: SecretBox, payload: string, context: string): boolean {
  try {
    box.decrypt(payload, context);
    return true;
  } catch {
    return false;
  }
}
