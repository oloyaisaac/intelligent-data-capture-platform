import { randomBytes, randomUUID, timingSafeEqual, createHash } from 'node:crypto';

/**
 * Identifier and secret helpers.
 *
 * Note: this module uses `node:crypto`, so it is backend/desktop only. Mobile identifiers are
 * generated on the backend or via the platform's native random source.
 */

/** UUID v4 for primary keys. */
export function newId(): string {
  return randomUUID();
}

/**
 * Time-sortable id: 48-bit millisecond timestamp + 80 bits of randomness, base32-encoded.
 * Reads well in logs and sorts by creation time (used for pairing tokens and job ids).
 */
export function newSortableId(now: number = Date.now()): string {
  const time = Buffer.alloc(6);
  time.writeUIntBE(now, 0, 6);
  const random = randomBytes(10);
  return base32(Buffer.concat([time, random]));
}

const BASE32_ALPHABET = '0123456789abcdefghjkmnpqrstvwxyz'; // Crockford, no i/l/o/u

function base32(buffer: Buffer): string {
  let bits = 0;
  let value = 0;
  let output = '';
  for (const byte of buffer) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) output += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  return output;
}

/** Cryptographically random URL-safe token (default 32 bytes ≈ 256 bits). */
export function newToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

/**
 * Hash a secret (refresh token, device credential, API key) for storage.
 * SHA-256 is appropriate here because these are high-entropy random values, not passwords.
 */
export function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

/** Constant-time comparison of two hex digests or tokens. */
export function safeCompare(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

/** Stable, non-reversible hash for IP addresses in logs and audit records. */
export function hashIp(ip: string, pepper = 'idcp'): string {
  return createHash('sha256').update(`${pepper}:${ip}`, 'utf8').digest('hex').slice(0, 32);
}

/** Whether a string looks like a UUID (used to sanitise path parameters before queries). */
export function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}
