import { z } from 'zod';

/**
 * Configuration is read from the environment, validated once at startup, and never read from
 * `process.env` anywhere else. A bad value must fail fast with an actionable message.
 */

const booleanish = z
  .union([z.boolean(), z.string()])
  .transform((value) =>
    typeof value === 'boolean' ? value : ['1', 'true', 'yes', 'on'].includes(value.toLowerCase()),
  );

const IntFromString = (defaultValue: number, min = 0, max = Number.MAX_SAFE_INTEGER) =>
  z.coerce.number().int().min(min).max(max).default(defaultValue);

const ConfigSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: IntFromString(4000, 1, 65535),
  API_BASE_URL: z.string().url().default('http://localhost:4000/api/v1'),
  LOG_LEVEL: z.enum(['error', 'warn', 'info', 'debug']).default('info'),

  /** `sqlite` for local development and tests; `postgres` in production. */
  DB_DRIVER: z.enum(['sqlite', 'postgres']).default('sqlite'),
  SQLITE_PATH: z.string().default('./local-storage/idcp.db'),
  DATABASE_URL: z.string().optional(),
  DATABASE_POOL_SIZE: IntFromString(10, 1, 100),

  JWT_SECRET: z.string().min(16).default('local-development-secret-do-not-use-in-production'),
  ACCESS_TOKEN_TTL_SECONDS: IntFromString(900, 60, 86_400),
  REFRESH_TOKEN_TTL_SECONDS: IntFromString(30 * 24 * 60 * 60, 60, 365 * 24 * 60 * 60),
  PAIRING_TOKEN_TTL_SECONDS: IntFromString(120, 30, 600),
  /** DEC-030: how long a password-reset link stays usable. */
  PASSWORD_RESET_TTL_SECONDS: IntFromString(60 * 60, 300, 24 * 60 * 60),

  STORAGE_DRIVER: z.enum(['filesystem', 's3']).default('filesystem'),
  STORAGE_PATH: z.string().default('./local-storage/documents'),

  AI_PROVIDER: z.enum(['local', 'cloud']).default('local'),
  AI_LOCAL_ENGINE: z.enum(['tesseract']).default('tesseract'),
  TESSERACT_BIN: z.string().default('tesseract'),
  AI_CLOUD_ENDPOINT: z.string().url().optional(),
  AI_CLOUD_API_KEY: z.string().optional(),
  AI_CLOUD_MODEL: z.string().default('gpt-4o-mini'),
  AI_MAX_COST_MICROS_PER_DOC: IntFromString(0, 0),
  AI_REVIEW_CONFIDENCE_THRESHOLD: z.coerce.number().min(0).max(1).default(0.85),

  MAX_UPLOAD_MB: IntFromString(20, 1, 200),
  MAX_REQUEST_MB: IntFromString(50, 1, 500),
  RATE_LIMIT_ENABLED: booleanish.default(true),
  RATE_LIMIT_AUTH_PER_15_MIN: IntFromString(5, 1, 10_000),
  RATE_LIMIT_UPLOAD_PER_MIN: IntFromString(60, 1, 100_000),

  APP_ORIGIN: z.string().default('http://localhost:5173'),
  /** Directory holding PRIVACY.md, TERMS.md, DPA.md … served by GET /api/v1/legal/:slug. */
  LEGAL_DIR: z.string().default('./legal'),
  CORS_ORIGINS: z.string().default(''),
  EXPORTS_TTL_SECONDS: IntFromString(7 * 24 * 60 * 60, 60),
  /** TEAM-001: how long an invitation link stays usable. */
  INVITATION_TTL_SECONDS: IntFromString(7 * 24 * 60 * 60, 300, 30 * 24 * 60 * 60),
  WORKER_ENABLED: booleanish.default(true),
  WORKER_POLL_INTERVAL_MS: IntFromString(500, 50, 60_000),
  /** Daily housekeeping: retention, expired exports, dead sessions (DEC-031). */
  MAINTENANCE_ENABLED: booleanish.default(true),
  MAINTENANCE_INTERVAL_MS: IntFromString(24 * 60 * 60 * 1000, 60_000),
  /**
   * Whether `X-Forwarded-For` may set the client IP (DEC-033).
   *
   * True is right behind the documented reverse proxy, which overwrites the header. It is wrong when
   * the API is reachable directly: a client could then forge the header and walk past per-IP rate
   * limits. Set `TRUST_PROXY=false` in that case.
   */
  TRUST_PROXY: booleanish.default(true),
});

export type Config = z.infer<typeof ConfigSchema>;

/**
 * Every environment key this service reads.
 *
 * Exported so `.env.example` can be checked against it (test/config.test.ts): a key that exists in
 * one and not the other is a documentation bug that otherwise only shows up when someone copies the
 * example and the server refuses to start.
 */
export const CONFIG_ENV_KEYS = Object.keys(ConfigSchema.shape) as Array<keyof Config>;

function describeIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => `  ${issue.path.join('.') || '(root)'}: ${issue.message}`)
    .join('\n');
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = ConfigSchema.safeParse(env);
  if (!parsed.success) {
    throw new Error(`Invalid configuration:\n${describeIssues(parsed.error)}`);
  }
  const config = parsed.data;

  // Cross-field rules that zod cannot express cleanly.
  if (config.DB_DRIVER === 'postgres' && !config.DATABASE_URL) {
    throw new Error('Invalid configuration:\n  DATABASE_URL: required when DB_DRIVER=postgres');
  }
  if (config.STORAGE_DRIVER === 's3') {
    throw new Error(
      'Invalid configuration:\n  STORAGE_DRIVER: the s3 adapter is not implemented yet (see PRD.json SEC-001/DEPLOYMENT.md); use filesystem locally',
    );
  }
  if (config.AI_PROVIDER === 'cloud') {
    if (!config.AI_CLOUD_ENDPOINT || !config.AI_CLOUD_API_KEY) {
      throw new Error(
        'Invalid configuration:\n  AI_CLOUD_ENDPOINT/AI_CLOUD_API_KEY: required when AI_PROVIDER=cloud',
      );
    }
    if (config.AI_MAX_COST_MICROS_PER_DOC <= 0) {
      throw new Error(
        'Invalid configuration:\n  AI_MAX_COST_MICROS_PER_DOC: set a spend cap before enabling cloud AI (PRD.json Q-001)',
      );
    }
  }
  if (config.NODE_ENV === 'production') {
    if (config.JWT_SECRET === 'local-development-secret-do-not-use-in-production') {
      throw new Error('Invalid configuration:\n  JWT_SECRET: set a unique secret in production');
    }
    if (config.JWT_SECRET.length < 32) {
      throw new Error(
        'Invalid configuration:\n  JWT_SECRET: must be at least 32 characters in production',
      );
    }
    if (!config.CORS_ORIGINS) {
      throw new Error('Invalid configuration:\n  CORS_ORIGINS: required in production');
    }
  }
  return config;
}

export function corsOrigins(config: Config): string[] {
  return config.CORS_ORIGINS.split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);
}
