import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';

/**
 * Envelope encryption for connector credentials at rest (SECURITY.md §6.2).
 *
 * AES-256-GCM with a per-record IV and the record's organisation as additional authenticated
 * data, so a ciphertext copied between tenants fails to decrypt. The key is derived from the
 * application secret; rotating that secret therefore requires re-entering connector credentials,
 * which is the honest trade-off for not shipping a separate KMS in Phase 1.
 */
export interface SecretBox {
  encrypt(plaintext: string, context: string): string;
  decrypt(payload: string, context: string): string;
}

const PREFIX = 'v1';

const createSecretBox = (secret: string, encryptionKey?: string): SecretBox => {
  // MH-09 Fix: Separate encryption key from JWT_SECRET
  // If encryptionKey is provided (from config.ENCRYPTION_KEY), use it for connector credentials.
  // Otherwise, fall back to JWT_SECRET derivation (legacy compatibility, but rotation safe).
  const baseSecret = encryptionKey || secret;
  const key = scryptSync(baseSecret, 'idcp-connector-credentials', 32);

  return {
    encrypt(plaintext, context) {
      const iv = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', key, iv);
      cipher.setAAD(Buffer.from(context, 'utf8'));
      const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
      const tag = cipher.getAuthTag();
      return [
        PREFIX,
        iv.toString('base64'),
        tag.toString('base64'),
        encrypted.toString('base64'),
      ].join(':');
    },

    decrypt(payload, context) {
      const [version, ivPart, tagPart, dataPart] = payload.split(':');
      if (version !== PREFIX || !ivPart || !tagPart || !dataPart) {
        throw new Error('Stored connector credentials are not readable. Re-enter them.');
      }
      try {
        const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(ivPart, 'base64'));
        decipher.setAAD(Buffer.from(context, 'utf8'));
        decipher.setAuthTag(Buffer.from(tagPart, 'base64'));
        return Buffer.concat([
          decipher.update(Buffer.from(dataPart, 'base64')),
          decipher.final(),
        ]).toString('utf8');
      } catch {
        throw new Error('Stored connector credentials could not be decrypted. Re-enter them.');
      }
    },
  };
};

export function createSecretBox(secret: string): SecretBox {
  // Legacy wrapper for existing calls (MH-09 transition)
  return createSecretBox(secret, process.env.ENCRYPTION_KEY);
}
