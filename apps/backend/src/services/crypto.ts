import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';

/**
 * Envelope encryption for connector credentials and MFA secrets at rest (SECURITY.md §6.2, MH-09).
 *
 * AES-256-GCM with a per-record IV and the record's organisation/user context as additional
 * authenticated data, so a ciphertext copied between tenants fails to decrypt.
 *
 * Key material is derived from `ENCRYPTION_KEY` (separate from `JWT_SECRET` so access-token key
 * rotation never breaks stored credentials). An optional legacy fallback secret allows existing
 * ciphertexts encrypted before key separation to remain readable until re-encrypted.
 */
export interface SecretBox {
  encrypt(plaintext: string, context: string): string;
  decrypt(payload: string, context: string): string;
}

const PREFIX = 'v1';
const KDF_SALT = 'idcp-connector-credentials';

function decryptWithKey(
  key: Buffer,
  iv: Buffer,
  tag: Buffer,
  ciphertext: Buffer,
  context: string,
): string {
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAAD(Buffer.from(context, 'utf8'));
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
}

export function createSecretBox(encryptionSecret: string, fallbackSecret?: string): SecretBox {
  const primaryKey = scryptSync(encryptionSecret, KDF_SALT, 32);
  const fallbackKey =
    fallbackSecret && fallbackSecret !== encryptionSecret
      ? scryptSync(fallbackSecret, KDF_SALT, 32)
      : null;

  return {
    encrypt(plaintext, context) {
      const iv = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', primaryKey, iv);
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
      const iv = Buffer.from(ivPart, 'base64');
      const tag = Buffer.from(tagPart, 'base64');
      const ciphertext = Buffer.from(dataPart, 'base64');

      try {
        return decryptWithKey(primaryKey, iv, tag, ciphertext, context);
      } catch {
        if (fallbackKey) {
          try {
            return decryptWithKey(fallbackKey, iv, tag, ciphertext, context);
          } catch {
            // Fall through to uniform error below.
          }
        }
        throw new Error('Stored connector credentials could not be decrypted. Re-enter them.');
      }
    },
  };
}
