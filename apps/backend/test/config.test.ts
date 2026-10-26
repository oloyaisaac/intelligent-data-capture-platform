import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CONFIG_ENV_KEYS, loadConfig } from '../src/config';

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
