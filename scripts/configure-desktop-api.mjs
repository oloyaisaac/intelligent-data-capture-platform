#!/usr/bin/env node
/**
 * Validates and embeds the public API base URL in the Electron main-process build.
 *
 * API_BASE_URL is an origin/path, never a credential. The value is intentionally baked into the
 * signed desktop artefact, as required by DEPLOYMENT.md §4: the release must not depend on the
 * launching user's shell environment. `--check` validates without writing and is used before the
 * relatively expensive renderer/installer build.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../apps/desktop');
const output = join(desktopRoot, 'dist-electron', 'api-config.json');
const raw = (process.env.API_BASE_URL ?? '').trim();

function fail(message) {
  console.error(`Desktop API configuration error: ${message}`);
  process.exit(1);
}

if (!raw) {
  fail(
    'API_BASE_URL is required to package the desktop app. Set it to the public API base, e.g. ' +
      'https://api.example.com/api/v1.',
  );
}

let url;
try {
  url = new URL(raw);
} catch {
  fail(`API_BASE_URL must be an absolute URL including its scheme (received "${raw}").`);
}

const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
const loopback =
  hostname === 'localhost' ||
  hostname === '127.0.0.1' ||
  hostname === '::1' ||
  hostname.endsWith('.localhost');

if (url.protocol !== 'https:' && url.protocol !== 'http:') {
  fail(`API_BASE_URL must use https: (received "${url.protocol}").`);
}
if (url.protocol === 'http:' && !loopback) {
  fail(
    'API_BASE_URL must use https: for non-loopback hosts; bearer tokens must not use cleartext.',
  );
}
if (url.username || url.password) fail('API_BASE_URL must not embed credentials.');
if (url.search || url.hash) fail('API_BASE_URL must not contain a query string or fragment.');

const apiBaseUrl = `${url.origin}${url.pathname}`.replace(/\/$/, '');

if (process.argv.includes('--check')) {
  console.log(`Desktop API configuration is valid (${url.origin}).`);
} else {
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, `${JSON.stringify({ apiBaseUrl }, null, 2)}\n`, { mode: 0o644 });
  console.log(`Wrote the public API base URL to ${output} (${url.origin}).`);
}
