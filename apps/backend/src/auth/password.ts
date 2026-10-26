import { Algorithm, hash, verify } from '@node-rs/argon2';

/**
 * Password hashing with Argon2id (SECURITY.md §4).
 *
 * Parameters follow OWASP guidance (memory 64 MiB, iterations 3, parallelism 1). They are
 * intentionally a little above the library defaults so a leaked hash is expensive to crack.
 */

export interface PasswordHasher {
  hash(password: string): Promise<string>;
  verify(passwordHash: string, password: string): Promise<boolean>;
}

const OPTIONS = {
  algorithm: Algorithm.Argon2id,
  memoryCost: 65_536,
  timeCost: 3,
  parallelism: 1,
} as const;

export const argon2Hasher: PasswordHasher = {
  hash: (password) => hash(password, OPTIONS),
  verify: async (passwordHash, password) => {
    try {
      return await verify(passwordHash, password, OPTIONS);
    } catch {
      // A malformed hash must read as "wrong password", never as a 500.
      return false;
    }
  },
};

/**
 * Cheap, well-known list of the worst passwords. A full breached-password check (k-anonymity
 * against a remote list) is a `SECURITY.md` follow-up; this blocks the obvious cases offline.
 */
const WEAK_PASSWORDS = new Set([
  'password1234',
  'passwordpassword',
  '123456789012',
  'qwertyuiop12',
  'letmeinplease',
  'administrator',
  'welcome12345',
]);

export function validatePasswordStrength(password: string): { ok: boolean; reason?: string } {
  if (password.length < 12) return { ok: false, reason: 'Use at least 12 characters.' };
  if (password.length > 256) return { ok: false, reason: 'Use at most 256 characters.' };
  if (WEAK_PASSWORDS.has(password.toLowerCase())) {
    return { ok: false, reason: 'That password is too common. Choose another.' };
  }
  if (/^(.)\1+$/.test(password))
    return { ok: false, reason: 'Use more than one repeated character.' };
  return { ok: true };
}
