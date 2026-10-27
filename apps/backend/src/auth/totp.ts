import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Time-based one-time passwords (RFC 6238), TOTP only, no dependency.
 *
 * Why hand-rolled rather than `otplib`: this is forty lines of well-specified arithmetic over
 * `node:crypto`, it is exercised against the RFC's own test vectors below, and the alternative is
 * another transitive dependency in the path that protects account takeover. The parts that are easy
 * to get wrong — base32 padding, the dynamic truncation offset, the accepted drift window — are the
 * parts the tests pin down.
 */

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
export const TOTP_STEP_SECONDS = 30;
export const TOTP_DIGITS = 6;

/** RFC 4226 §5.1 base32, unpadded — what every authenticator app expects in an `otpauth:` URI. */
export function base32Encode(buffer: Buffer): string {
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

export function base32Decode(input: string): Buffer {
  const cleaned = input.toUpperCase().replace(/=+$/, '').replace(/\s+/g, '');
  let bits = 0;
  let value = 0;
  const bytes: number[] = [];
  for (const character of cleaned) {
    const index = BASE32_ALPHABET.indexOf(character);
    if (index === -1) throw new Error('Secret is not valid base32.');
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

/** A fresh 160-bit secret, the length RFC 4226 §4 recommends for HMAC-SHA-1. */
export function generateTotpSecret(): string {
  return base32Encode(randomBytes(20));
}

/** HOTP (RFC 4226 §5.3) with dynamic truncation, rendered as six digits. */
export function hotp(secret: string, counter: number, digits = TOTP_DIGITS): string {
  const key = base32Decode(secret);
  const buffer = Buffer.alloc(8);
  buffer.writeBigUInt64BE(BigInt(counter));
  const digest = createHmac('sha1', key).update(buffer).digest();
  const offset = digest[digest.length - 1]! & 0x0f;
  const binary =
    ((digest[offset]! & 0x7f) << 24) |
    ((digest[offset + 1]! & 0xff) << 16) |
    ((digest[offset + 2]! & 0xff) << 8) |
    (digest[offset + 3]! & 0xff);
  return String(binary % 10 ** digits).padStart(digits, '0');
}

export function totp(secret: string, at: number = Date.now(), step = TOTP_STEP_SECONDS): string {
  return hotp(secret, Math.floor(at / 1000 / step));
}

/**
 * Verifies a code, accepting one step of clock drift either side (30 s early or late).
 *
 * `window` is deliberately 1: bigger windows make an intercepted code usable for minutes, which is
 * exactly the property MFA is supposed to remove. Comparison is constant-time.
 */
export function verifyTotp(
  secret: string,
  code: string,
  options: { at?: number; window?: number; step?: number } = {},
): boolean {
  const { at = Date.now(), window = 1, step = TOTP_STEP_SECONDS } = options;
  const candidate = code.replace(/\s+/g, '');
  if (!/^\d{6}$/.test(candidate)) return false;
  const counter = Math.floor(at / 1000 / step);
  const expected = Buffer.from(candidate);
  for (let offset = -window; offset <= window; offset += 1) {
    const computed = Buffer.from(hotp(secret, counter + offset));
    if (computed.length === expected.length && timingSafeEqual(computed, expected)) return true;
  }
  return false;
}

/** The URI an authenticator app scans or takes as a manual entry. */
export function otpauthUri(input: {
  secret: string;
  account: string;
  issuer: string;
  digits?: number;
  step?: number;
}): string {
  const label = encodeURIComponent(`${input.issuer}:${input.account}`);
  const params = new URLSearchParams({
    secret: input.secret,
    issuer: input.issuer,
    algorithm: 'SHA1',
    digits: String(input.digits ?? TOTP_DIGITS),
    period: String(input.step ?? TOTP_STEP_SECONDS),
  });
  return `otpauth://totp/${label}?${params.toString()}`;
}
