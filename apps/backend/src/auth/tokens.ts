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
 * Fixed-window in-memory rate limiter for authentication attempts.
 * Production uses the edge/Redis limiter (API.md §10); this keeps the API honest when deployed
 * as a single process, and is what the tests exercise.
 */
export class AttemptLimiter {
  private readonly hits = new Map<string, { count: number; resetAt: number }>();

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
    private readonly now: () => number = Date.now,
    private readonly enabled: boolean = true,
  ) {}

  /** Returns true when the attempt is allowed, false when the caller is over the limit. */
  hit(key: string): boolean {
    if (!this.enabled) return true;
    const current = this.now();
    const entry = this.hits.get(key);

    if (!entry || entry.resetAt <= current) {
      this.hits.set(key, { count: 1, resetAt: current + this.windowMs });
      return true;
    }
    if (entry.count >= this.limit) return false;
    entry.count += 1;
    return true;
  }

  retryAfterSeconds(key: string): number {
    if (!this.enabled) return 0;
    const entry = this.hits.get(key);
    if (!entry) return 0;
    return Math.max(0, Math.ceil((entry.resetAt - this.now()) / 1000));
  }

  reset(key?: string): void {
    if (key) this.hits.delete(key);
    else this.hits.clear();
  }
}
