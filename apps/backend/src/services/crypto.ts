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

export function createSecretBox(secret: string): SecretBox {\n  // MH-09 Fix: Separate encryption key from JWT_SECRET\n  // If encryptionKey is provided (from config.ENCRYPTION_KEY), use it for connector credentials.\n  // Otherwise, fall back to JWT_SECRET derivation (legacy compatibility, but rotation safe).\n  const baseSecret = process.env.ENCRYPTION_KEY || secret;\n  const key = scryptSync(baseSecret, 'idcp-connector-credentials', 32);\n\n  return {\n    encrypt(plaintext, context) {\n      const iv = randomBytes(12);\n      const cipher = createCipheriv('aes-256-gcm', key, iv);\n      cipher.setAAD(Buffer.from(context, 'utf8'));\n      const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);\n      const tag = cipher.getAuthTag();\n      return [\n        PREFIX,\n        iv.toString('base64'),\n        tag.toString('base64'),\n        encrypted.toString('base64'),\n      ].join(':');\n    },\n\n    decrypt(payload, context) {\n      const [version, ivPart, tagPart, dataPart] = payload.split(':');\n      if (version !== PREFIX || !ivPart || !tagPart || !dataPart) {\n        throw new Error('Stored connector credentials are not readable. Re-enter them.');\n      }\n      try {\n        const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(ivPart, 'base64'));\n        decipher.setAAD(Buffer.from(context, 'utf8'));\n        decipher.setAuthTag(Buffer.from(tagPart, 'base64'));\n        return Buffer.concat([\n          decipher.update(Buffer.from(dataPart, 'base64')),\n          decipher.final(),\n        ]).toString('utf8');\n      } catch {\n        throw new Error('Stored connector credentials could not be decrypted. Re-enter them.');\n      }\n    },\n  };\n};\n
