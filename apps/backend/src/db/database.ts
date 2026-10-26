/**
 * Database abstraction.
 *
 * SQL is written once, in a portable subset:
 *   - placeholders are `?` (the Postgres adapter rewrites them to `$1..$n`)
 *   - booleans are stored as INTEGER 0/1
 *   - timestamps are stored as ISO-8601 TEXT (sorts correctly, no timezone ambiguity)
 *   - JSON is stored as TEXT and parsed in the repository layer
 *
 * This keeps one migration set and one set of queries for both SQLite (local dev, tests) and
 * PostgreSQL (production). See DECISIONS.md DEC-013.
 */

export type SqlParams = unknown[];

export interface Database {
  readonly driver: 'sqlite' | 'postgres';
  query<T = Record<string, unknown>>(sql: string, params?: SqlParams): Promise<T[]>;
  one<T = Record<string, unknown>>(sql: string, params?: SqlParams): Promise<T | null>;
  execute(sql: string, params?: SqlParams): Promise<void>;
  transaction<T>(fn: (db: Database) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

/** Rewrites `?` placeholders into `$1..$n`, ignoring question marks inside string literals. */
export function toPostgresPlaceholders(sql: string): string {
  let index = 0;
  let inSingle = false;
  let output = '';
  for (const char of sql) {
    if (char === "'") inSingle = !inSingle;
    if (char === '?' && !inSingle) {
      index += 1;
      output += `$${index}`;
      continue;
    }
    output += char;
  }
  return output;
}

export function nowIso(): string {
  return new Date().toISOString();
}

/** SQLite has no boolean type; Postgres accepts 0/1 in an INTEGER column too. */
export function toDbBool(value: boolean): number {
  return value ? 1 : 0;
}

export function fromDbBool(value: unknown): boolean {
  return value === 1 || value === true || value === '1';
}

export function parseJson<T>(value: unknown, fallback: T): T {
  if (value === null || value === undefined) return fallback;
  if (typeof value !== 'string') return value as T;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

export function toJson(value: unknown): string {
  return JSON.stringify(value ?? null);
}

/** Normalise a DB value into an ISO timestamp string or null. */
export function dbTimestamp(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString();
  return String(value);
}
