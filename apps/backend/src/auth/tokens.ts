import jwt from 'jsonwebtoken';
import { type Role } from '@idcp/shared';
import { hashToken, newToken } from '@idcp/shared/ids';

/**
 * Token handling:
 *  - access tokens are short-lived JWTs (≤ 15 min) carrying only sub/org/role
 *  - refresh tokens are opaque, high-entropy, stored only as SHA-256 hashes, and rotated on use
 *  - device credentials are opaque and hashed the same way
 * (SECURITY.md §4; API.md §3.)
 */

export interface AccessTokenClaims {
  sub: string;
  org: string;
  role: Role;
}

export interface TokenService {
  signAccessToken(claims: AccessTokenClaims): string;
  verifyAccessToken(token: string): AccessTokenClaims | null;
  /** Five-minute, single-purpose token proving the password step succeeded (DEC-034). */
  signMfaChallenge(userId: string): string;
  verifyMfaChallenge(token: string): { userId: string } | null;
  createRefreshToken(): { token: string; hash: string };
  createDeviceCredential(): { token: string; hash: string };
}

export function createTokenService(options: {
  secret: string;
  accessTtlSeconds: number;
}): TokenService {
  const { secret, accessTtlSeconds } = options;

  return {
    signAccessToken(claims) {
      return jwt.sign({ org: claims.org, role: claims.role }, secret, {
        subject: claims.sub,
        expiresIn: accessTtlSeconds,
        algorithm: 'HS256',
        issuer: 'idcp',
        audience: 'idcp-api',
      });
    },

    verifyAccessToken(token) {
      try {
        const payload = jwt.verify(token, secret, {
          algorithms: ['HS256'],
          issuer: 'idcp',
          audience: 'idcp-api',
        });
        if (typeof payload === 'string' || !payload.sub) return null;
        const org = payload.org;
        const role = payload.role;
        if (typeof org !== 'string' || typeof role !== 'string') return null;
        return { sub: payload.sub, org, role: role as Role };
      } catch {
        return null;
      }
    },

    signMfaChallenge(userId) {
      return jwt.sign({ scope: 'mfa' }, secret, {
        subject: userId,
        expiresIn: 300,
        algorithm: 'HS256',
        issuer: 'idcp',
        audience: 'idcp-mfa',
      });
    },

    verifyMfaChallenge(token) {
      try {
        const payload = jwt.verify(token, secret, {
          algorithms: ['HS256'],
          issuer: 'idcp',
          audience: 'idcp-mfa',
        });
        if (typeof payload === 'string' || !payload.sub) return null;
        if (payload.scope !== 'mfa') return null;
        return { userId: payload.sub };
      } catch {
        return null;
      }
    },

    createRefreshToken() {
      const token = newToken(32);
      return { token, hash: hashToken(token) };
    },

    createDeviceCredential() {
      const token = `dev_${newToken(32)}`;
      return { token, hash: hashToken(token) };
    },
  };
}

/**
 * Fixed-window, process-local limiter. Expired entries are swept on demand at intervals of the
 * window length or one minute, whichever is shorter. Capacity is bounded; when full, new keys fail
 * closed rather than evicting an active key and resetting its limit. Replicas need a shared limiter.
 */
export class AttemptLimiter {
  private readonly hits = new Map<string, { count: number; resetAt: number }>();
  private nextSweepAt = 0;

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
    private readonly now: () => number = Date.now,
    private readonly enabled: boolean = true,
    private readonly maxEntries: number = 10_000,
  ) {
    if (!Number.isSafeInteger(maxEntries) || maxEntries < 1) {
      throw new Error('Rate limiter capacity must be a positive integer.');
    }
  }

  /** Returns true when the attempt is allowed, false when over the limit or capacity. */
  hit(key: string): boolean {
    if (!this.enabled) return true;
    const current = this.now();
    if (current >= this.nextSweepAt) {
      for (const [storedKey, entry] of this.hits) {
        if (entry.resetAt <= current) this.hits.delete(storedKey);
      }
      this.nextSweepAt = current + Math.min(this.windowMs, 60_000);
    }
    // Fixed-size hashes bound key storage and avoid retaining raw email addresses or IPs.
    const storedKey = hashToken(key);
    const entry = this.hits.get(storedKey);
    if (!entry || entry.resetAt <= current) {
      if (!entry && this.hits.size >= this.maxEntries) return false;
      this.hits.set(storedKey, { count: 1, resetAt: current + this.windowMs });
      return true;
    }
    if (entry.count >= this.limit) return false;
    entry.count += 1;
    return true;
  }

  retryAfterSeconds(key: string): number {
    if (!this.enabled) return 0;
    const current = this.now();
    const entry = this.hits.get(hashToken(key));
    if (entry) return Math.max(0, Math.ceil((entry.resetAt - current) / 1000));
    // An unknown key may have been refused because the map was full.
    return this.hits.size >= this.maxEntries
      ? Math.max(1, Math.ceil((this.nextSweepAt - current) / 1000))
      : 0;
  }

  reset(key?: string): void {
    if (key !== undefined) this.hits.delete(hashToken(key));
    else this.hits.clear();
  }
}
