import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import ts from 'typescript';
import {
  CONFIG_ENV_KEYS,
  loadConfig,
  loadEncryptionMigrationConfig,
  loadSeedConfig,
} from '../src/config';

/**
 * The environment contract (ENVIRONMENT.md §4, and the rule in AI.md §7).
 *
 * `.env.example` is the only thing a new contributor is told to copy, so it has to be *true*: every
 * key the server reads must appear there, and every key there must be read by something. This suite
 * exists because the example drifted once — it kept a `minio` storage driver and an empty
 * `AI_CLOUD_ENDPOINT`, and `cp .env.example .env` made the API refuse to start.
 */

const examplePath = join(__dirname, '../../../.env.example');
const example = readFileSync(examplePath, 'utf8');

/** Values that configure the clients, not the server, so `ConfigSchema` never sees them. */
const CLIENT_KEYS = ['IDCP_API_URL', 'IDCP_API_PROXY', 'IDCP_DEV_SERVER', 'IDCP_AUTO_UPDATE'];

/** Parses KEY=value lines, ignoring comments, blanks and the inline `# note` after a value. */
function parseEnvFile(contents: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of contents.split('\n')) {
    const match = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(line);
    if (!match) continue;
    const value = match[2]!.split('#')[0]!.trim();
    out[match[1]!] = value;
  }
  return out;
}

describe('environment entry points', () => {
  const jwt = 'legacy-jwt-secret-0123456789abcdef';
  const encryption = 'dedicated-encryption-key-0123456789';

  it('injects the npm version without adding CLI-only secrets to application config', () => {
    const config = loadConfig({
      npm_package_version: '1.2.3',
      ENCRYPTION_MIGRATION_SOURCE_KEY: jwt,
    });
    expect(config.appVersion).toBe('1.2.3');
    expect(config).not.toHaveProperty('ENCRYPTION_MIGRATION_SOURCE_KEY');
    expect(loadConfig({}).appVersion).toBe('0.1.0');
  });

  it('reads seed overrides separately while preserving defaults and empty values', () => {
    expect(loadSeedConfig({})).toMatchObject({
      email: 'owner@example.com',
      password: 'demo-password-change-me',
    });
    const seed = loadSeedConfig({ SEED_EMAIL: 'custom@example.com', SEED_PASSWORD: '' });
    expect(seed.email).toBe('custom@example.com');
    expect(seed.password).toBe('');
    expect(seed.config).not.toHaveProperty('SEED_PASSWORD');
  });

  it('requires explicit distinct migration keys and keeps source-key fallback behavior', () => {
    const env = { JWT_SECRET: jwt, ENCRYPTION_KEY: encryption };
    expect(loadEncryptionMigrationConfig(env).sourceSecret).toBe(jwt);
    expect(
      loadEncryptionMigrationConfig({ ...env, ENCRYPTION_MIGRATION_SOURCE_KEY: '' }).sourceSecret,
    ).toBe(jwt);
    const oldKey = 'old-encryption-key-0123456789abcdef';
    const result = loadEncryptionMigrationConfig({
      ...env,
      ENCRYPTION_MIGRATION_SOURCE_KEY: oldKey,
    });
    expect(result.sourceSecret).toBe(oldKey);
    expect(result.config).not.toHaveProperty('ENCRYPTION_MIGRATION_SOURCE_KEY');
    expect(() => loadEncryptionMigrationConfig({})).toThrow(/Explicit, distinct/);
    expect(() => loadEncryptionMigrationConfig({ JWT_SECRET: jwt })).toThrow(/Explicit, distinct/);
    expect(() => loadEncryptionMigrationConfig({ ENCRYPTION_KEY: encryption })).toThrow(
      /Explicit, distinct/,
    );
    expect(() => loadEncryptionMigrationConfig({ JWT_SECRET: jwt, ENCRYPTION_KEY: jwt })).toThrow(
      /Explicit, distinct/,
    );
    expect(() =>
      loadEncryptionMigrationConfig({ ...env, ENCRYPTION_KEY: 'too-short-but-valid' }),
    ).toThrow(/Explicit, distinct/);
    expect(() =>
      loadEncryptionMigrationConfig({ ...env, ENCRYPTION_MIGRATION_SOURCE_KEY: 'too-short' }),
    ).toThrow(/source key/i);
    expect(() =>
      loadEncryptionMigrationConfig({ ...env, ENCRYPTION_MIGRATION_SOURCE_KEY: encryption }),
    ).toThrow(/source key/i);
  });

  it('does not read process.env elsewhere in backend source', () => {
    const root = join(__dirname, '../src');
    const violations: string[] = [];
    function inspect(directory: string): void {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) {
          inspect(path);
          continue;
        }
        if (!entry.name.endsWith('.ts') || path === join(root, 'config.ts')) continue;
        const file = ts.createSourceFile(
          path,
          readFileSync(path, 'utf8'),
          ts.ScriptTarget.Latest,
          true,
        );
        function visit(node: ts.Node): void {
          const dot =
            ts.isPropertyAccessExpression(node) &&
            node.expression.getText(file) === 'process' &&
            node.name.text === 'env';
          const computed =
            ts.isElementAccessExpression(node) &&
            node.expression.getText(file) === 'process' &&
            ts.isStringLiteral(node.argumentExpression) &&
            node.argumentExpression.text === 'env';
          const destructured =
            ts.isVariableDeclaration(node) &&
            ts.isObjectBindingPattern(node.name) &&
            node.initializer?.getText(file) === 'process' &&
            node.name.elements.some(
              (element) => (element.propertyName ?? element.name).getText(file) === 'env',
            );
          if (dot || computed || destructured)
            violations.push(
              `${relative(root, path)}:${file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1}`,
            );
          ts.forEachChild(node, visit);
        }
        visit(file);
      }
    }
    inspect(root);
    expect(violations).toEqual([]);
  });
});

describe('.env.example matches the configuration the server reads (BACK-001)', () => {
  const documented = parseEnvFile(example);

  it('documents every key the server reads', () => {
    const missing = CONFIG_ENV_KEYS.filter((key) => !(key in documented));
    expect(missing).toEqual([]);
  });

  it('documents nothing the server does not read', () => {
    const known = new Set<string>([...CONFIG_ENV_KEYS, ...CLIENT_KEYS]);
    const unknown = Object.keys(documented).filter((key) => !known.has(key));
    expect(unknown).toEqual([]);
  });

  it('starts the server when copied verbatim, which is what the README tells people to do', () => {
    // Blank values mean "unset" in a real .env, so they are dropped before validation.
    const env = Object.fromEntries(Object.entries(documented).filter(([, value]) => value !== ''));
    const config = loadConfig(env);
    expect(config.DB_DRIVER).toBe('sqlite');
    expect(config.STORAGE_DRIVER).toBe('filesystem');
    expect(config.AI_PROVIDER).toBe('local');
    expect(config.WORKER_ENABLED).toBe(true);
    expect(config.PORT).toBe(4000);
  });

  it('waits for the cloud AI decision before allowing spend (Q-001)', () => {
    // The example is deliberately inert: no endpoint, no key, no budget. Turning cloud AI on is a
    // separate, deliberate edit that cannot happen by copying the file.
    const env = parseEnvFile(example);
    expect(env.AI_PROVIDER).toBe('local');
    expect(env.AI_MAX_COST_MICROS_PER_DOC).toBe('0');
    expect(env.AI_CLOUD_API_KEY).toBe('');
    expect(() =>
      loadConfig({ ...env, AI_PROVIDER: 'cloud', AI_MAX_COST_MICROS_PER_DOC: '0' }),
    ).toThrow(/AI_CLOUD_ENDPOINT|MICROS/);
  });

  it('lets a deployment turn off proxy trust (DEC-033)', () => {
    // Behind the documented reverse proxy, `X-Forwarded-For` is authoritative and the default is right.
    expect(loadConfig({}).TRUST_PROXY).toBe(true);
    // Exposed directly, the header is attacker-controlled: leave it out of the rate-limit key.
    expect(loadConfig({ TRUST_PROXY: 'false' }).TRUST_PROXY).toBe(false);
    expect(parseEnvFile(example).TRUST_PROXY).toBe('true');
  });

  it('keeps the storage adapter honest instead of advertising an unimplemented one', () => {
    expect(parseEnvFile(example).STORAGE_DRIVER).toBe('filesystem');
    expect(example).not.toMatch(/^STORAGE_DRIVER=minio/m);
    expect(example).not.toMatch(/^REDIS_URL=/m);
  });

  it('explains every key rather than listing it', () => {
    // A one-line comment per group plus a note on most keys; this guards against a bare list.
    const comments = example.split('\n').filter((line) => line.startsWith('#')).length;
    expect(comments).toBeGreaterThan(25);
    expect(example).toMatch(/never commit/i);
  });
});
