import { loadConfig } from '../src/config';
import {
  assertSafeKey,
  buildStorageKey,
  extensionForMimeType,
  sniffMimeType,
} from '../src/storage';
import { validatePasswordStrength } from '../src/auth/password';
import { AttemptLimiter } from '../src/auth/tokens';
import { createSecretBox } from '../src/services/crypto';
import { toPostgresPlaceholders } from '../src/db/database';
import { redact } from '../src/logger';

describe('configuration (BACK-001)', () => {
  const base = {
    JWT_SECRET: 'test-secret-that-is-long-enough-0123456789',
    NODE_ENV: 'test',
  } as NodeJS.ProcessEnv;

  it('applies safe local defaults', () => {
    const config = loadConfig(base);
    expect(config.PORT).toBe(4000);
    expect(config.DB_DRIVER).toBe('sqlite');
    expect(config.AI_PROVIDER).toBe('local');
    expect(config.MAX_UPLOAD_MB).toBe(20);
  });

  it('coerces numeric environment values', () => {
    const config = loadConfig({ ...base, PORT: '5001', AI_REVIEW_CONFIDENCE_THRESHOLD: '0.9' });
    expect(config.PORT).toBe(5001);
    expect(config.AI_REVIEW_CONFIDENCE_THRESHOLD).toBe(0.9);
  });

  it('rejects an out-of-range port with an actionable message', () => {
    expect(() => loadConfig({ ...base, PORT: '99999' })).toThrow(/PORT/);
  });

  it('requires a connection string for postgres', () => {
    expect(() => loadConfig({ ...base, DB_DRIVER: 'postgres' })).toThrow(/DATABASE_URL/);
  });

  it('refuses cloud AI without credentials or a spend cap (Q-001)', () => {
    expect(() => loadConfig({ ...base, AI_PROVIDER: 'cloud' })).toThrow(/AI_CLOUD_ENDPOINT/);
    expect(() =>
      loadConfig({
        ...base,
        AI_PROVIDER: 'cloud',
        AI_CLOUD_ENDPOINT: 'https://example.com/v1/chat',
        AI_CLOUD_API_KEY: 'key',
        AI_MAX_COST_MICROS_PER_DOC: '0',
      }),
    ).toThrow(/AI_MAX_COST_MICROS_PER_DOC/);
  });

  it('refuses the s3 driver until it is implemented', () => {
    expect(() => loadConfig({ ...base, STORAGE_DRIVER: 's3' })).toThrow(
      /s3 adapter is not implemented/i,
    );
  });

  it('hardens production configuration', () => {
    expect(() =>
      loadConfig({
        NODE_ENV: 'production',
        JWT_SECRET: 'local-development-secret-do-not-use-in-production',
      }),
    ).toThrow(/JWT_SECRET/);

    expect(() =>
      loadConfig({
        NODE_ENV: 'production',
        JWT_SECRET: 'x'.repeat(20),
        CORS_ORIGINS: 'https://app.example.com',
      }),
    ).toThrow(/at least 32 characters/);

    expect(() =>
      loadConfig({
        NODE_ENV: 'production',
        JWT_SECRET: 'x'.repeat(40),
        ENCRYPTION_KEY: 'y'.repeat(40),
      }),
    ).toThrow(/CORS_ORIGINS/);

    expect(() =>
      loadConfig({
        NODE_ENV: 'production',
        JWT_SECRET: 'x'.repeat(40),
        CORS_ORIGINS: 'https://app.example.com',
      }),
    ).toThrow(/ENCRYPTION_KEY/);

    expect(() =>
      loadConfig({
        NODE_ENV: 'production',
        JWT_SECRET: 'x'.repeat(40),
        ENCRYPTION_KEY: 'x'.repeat(40),
        CORS_ORIGINS: 'https://app.example.com',
      }),
    ).toThrow(/distinct from JWT_SECRET/);

    const ok = loadConfig({
      NODE_ENV: 'production',
      JWT_SECRET: 'x'.repeat(40),
      ENCRYPTION_KEY: 'y'.repeat(40),
      CORS_ORIGINS: 'https://app.example.com',
    });
    expect(ok.NODE_ENV).toBe('production');
  });
});

describe('upload safety (SECURITY.md §7)', () => {
  it('detects image and PDF content from magic bytes', () => {
    expect(sniffMimeType(Buffer.from('ffd8ffe000104a464946', 'hex'))).toBe('image/jpeg');
    expect(sniffMimeType(Buffer.from('89504e470d0a1a0a0000', 'hex'))).toBe('image/png');
    expect(sniffMimeType(Buffer.from('%PDF-1.7\n...', 'utf8'))).toBe('application/pdf');
    const heic = Buffer.concat([
      Buffer.from('00000018', 'hex'),
      Buffer.from('ftypheic', 'latin1'),
      Buffer.alloc(8),
    ]);
    expect(sniffMimeType(heic)).toBe('image/heic');
  });

  it('rejects unknown and truncated content', () => {
    expect(sniffMimeType(Buffer.from('MZ\x90\x00 not a document', 'latin1'))).toBeNull();
    expect(sniffMimeType(Buffer.from('short'))).toBeNull();
    expect(sniffMimeType(Buffer.from('<?xml version="1.0"?><svg/>', 'utf8'))).toBeNull();
  });

  it('maps mime types to extensions', () => {
    expect(extensionForMimeType('image/jpeg')).toBe('jpg');
    expect(extensionForMimeType('application/pdf')).toBe('pdf');
    expect(extensionForMimeType('application/x-evil')).toBe('bin');
  });

  it('refuses storage keys that try to escape the root', () => {
    expect(() => assertSafeKey('../secrets.env')).toThrow();
    expect(() => assertSafeKey('/etc/passwd')).toThrow();
    expect(() => assertSafeKey('org/a/../../b')).toThrow();
    expect(assertSafeKey('org/a/documents/x.png')).toBe('org/a/documents/x.png');
  });

  it('builds namespaced storage keys', () => {
    expect(
      buildStorageKey({ organisationId: 'org1', kind: 'exports', id: 'abc', extension: 'csv' }),
    ).toBe('org/org1/exports/abc.csv');
  });
});

describe('password policy', () => {
  it('enforces length and rejects the obvious', () => {
    expect(validatePasswordStrength('short').ok).toBe(false);
    expect(validatePasswordStrength('password1234').ok).toBe(false);
    expect(validatePasswordStrength('aaaaaaaaaaaaaa').ok).toBe(false);
    expect(validatePasswordStrength('a genuinely long passphrase').ok).toBe(true);
  });
});

describe('rate limiter', () => {
  it('allows up to the limit inside the window, then blocks', () => {
    let now = 0;
    const limiter = new AttemptLimiter(3, 1000, () => now);
    expect(limiter.hit('k')).toBe(true);
    expect(limiter.hit('k')).toBe(true);
    expect(limiter.hit('k')).toBe(true);
    expect(limiter.hit('k')).toBe(false);
    now = 1001;
    expect(limiter.hit('k')).toBe(true);
  });

  it('tracks keys independently and can be disabled', () => {
    const limiter = new AttemptLimiter(1, 1000, () => 0);
    expect(limiter.hit('a')).toBe(true);
    expect(limiter.hit('b')).toBe(true);
    expect(limiter.hit('a')).toBe(false);

    const disabled = new AttemptLimiter(1, 1000, () => 0, false);
    for (let attempt = 0; attempt < 10; attempt += 1) expect(disabled.hit('a')).toBe(true);
  });
});

describe('credential encryption (SECURITY.md §6.2)', () => {
  it('round-trips and binds ciphertext to its organisation', () => {
    const box = createSecretBox('a-test-secret');
    const payload = box.encrypt('{"password":"hunter2"}', 'org-1');
    expect(payload).not.toContain('hunter2');
    expect(box.decrypt(payload, 'org-1')).toBe('{"password":"hunter2"}');
    // A ciphertext moved to another tenant must not decrypt.
    expect(() => box.decrypt(payload, 'org-2')).toThrow(/could not be decrypted/i);
  });

  it('rejects tampered payloads', () => {
    const box = createSecretBox('a-test-secret');
    const payload = box.encrypt('secret', 'org-1');
    const parts = payload.split(':');
    parts[3] = Buffer.from('tampered').toString('base64');
    expect(() => box.decrypt(parts.join(':'), 'org-1')).toThrow();
    expect(() => box.decrypt('not-a-payload', 'org-1')).toThrow(/not readable/i);
  });

  it('keeps stored credentials readable across JWT_SECRET rotation and legacy fallback (MH-09)', () => {
    const legacyJwtBox = createSecretBox('legacy-jwt-secret-0123456789abcdef');
    const legacyPayload = legacyJwtBox.encrypt('{"token":"legacy"}', 'org-1');

    // Introducing a dedicated ENCRYPTION_KEY still decrypts legacy ciphertexts via fallback.
    const separatedBox = createSecretBox(
      'dedicated-encryption-key-0123456789',
      'legacy-jwt-secret-0123456789abcdef',
    );
    expect(separatedBox.decrypt(legacyPayload, 'org-1')).toBe('{"token":"legacy"}');

    // New ciphertexts use ENCRYPTION_KEY, so rotating JWT_SECRET later does not break decryption.
    const freshPayload = separatedBox.encrypt('{"token":"fresh"}', 'org-1');
    const afterJwtRotation = createSecretBox(
      'dedicated-encryption-key-0123456789',
      'rotated-new-jwt-secret-fedcba9876543210',
    );
    expect(afterJwtRotation.decrypt(freshPayload, 'org-1')).toBe('{"token":"fresh"}');
  });
});

describe('sql portability (DEC-013)', () => {
  it('rewrites ? placeholders for postgres without touching string literals', () => {
    expect(toPostgresPlaceholders('SELECT * FROM t WHERE a = ? AND b = ?')).toBe(
      'SELECT * FROM t WHERE a = $1 AND b = $2',
    );
    expect(toPostgresPlaceholders("SELECT '?' AS q, x FROM t WHERE y = ?")).toBe(
      "SELECT '?' AS q, x FROM t WHERE y = $1",
    );
  });
});

describe('log redaction (SECURITY.md §3)', () => {
  it('removes secrets and document values from log context', () => {
    const redacted = redact({
      requestId: 'req-1',
      password: 'hunter2',
      authorization: 'Bearer abc',
      accessToken: 'xyz',
      udm: { fields: {} },
      nested: { apiKey: 'k', count: 2 },
      error: new Error('db down'),
    });
    expect(redacted.requestId).toBe('req-1');
    expect(redacted.password).toBe('[redacted]');
    expect(redacted.authorization).toBe('[redacted]');
    expect(redacted.udm).toBe('[redacted]');
    expect((redacted.nested as Record<string, unknown>).apiKey).toBe('[redacted]');
    expect((redacted.nested as Record<string, unknown>).count).toBe(2);
    expect(JSON.stringify(redacted)).not.toContain('hunter2');
    // Error name/message are kept: operators need them to diagnose a failure. They must never be
    // given document content to begin with, which is why values are redacted upstream.
    expect((redacted.error as { name: string }).name).toBe('Error');
  });
});
