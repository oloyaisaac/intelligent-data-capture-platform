import type { ConnectorRow } from '../repositories/types';
import type { SecretBox } from './crypto';

// `config` is a marker only for new rows; both the complete configuration and separate
// credentials live in a single encrypted envelope. This also allows the existing key-rotation
// utility to re-encrypt the entire payload without treating fields as non-secret.
// The legacy API accepted only objects, so a JSON string marker cannot collide with a valid
// legacy configuration, including one that happens to contain our internal key names.
export const ENCRYPTED_CONFIG_MARKER = 'idcp:encrypted-config:v1' as const;

interface ConfigParts {
  config: Record<string, unknown>;
  credentials: Record<string, unknown>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export function encodeConnectorConfig(box: SecretBox, organisationId: string, parts: ConfigParts) {
  return {
    config: ENCRYPTED_CONFIG_MARKER,
    credentialsEncrypted: box.encrypt(JSON.stringify(parts), organisationId),
  };
}

export function isEncryptedConnectorConfig(config: unknown): boolean {
  return config === ENCRYPTED_CONFIG_MARKER;
}

export function decodeConnectorConfig(box: SecretBox, row: ConnectorRow): ConfigParts {
  const config: unknown = JSON.parse(row.config);
  const isEncrypted = isEncryptedConnectorConfig(config);
  if (!isEncrypted && !isRecord(config)) {
    throw new Error('Stored connector configuration is not readable.');
  }
  const decrypted: unknown = row.credentials_encrypted
    ? JSON.parse(box.decrypt(row.credentials_encrypted, row.organisation_id))
    : {};
  if (!isRecord(decrypted)) throw new Error('Stored connector credentials are not readable.');
  if (isEncrypted) {
    if (
      !row.credentials_encrypted ||
      !isRecord(decrypted.config) ||
      !isRecord(decrypted.credentials)
    ) {
      throw new Error('Stored connector configuration is not readable.');
    }
    return { config: decrypted.config, credentials: decrypted.credentials };
  }
  // Legacy rows are readable until an offline data migration is performed, but may contain
  // plaintext secrets. New code never returns their config and replaces it on configuration patch.
  if (!isRecord(config)) throw new Error('Stored connector configuration is not readable.');
  return { config, credentials: decrypted };
}
