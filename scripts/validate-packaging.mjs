#!/usr/bin/env node
/**
 * Checks the desktop packaging configuration (DESK-001).
 *
 * The Electron binary and electron-builder are not installed in CI (they need platform-specific
 * downloads), so the packaging contract is validated statically instead: three platform targets,
 * ASAR enabled, the built main process entry point, and no browser window that hands Node to the
 * renderer.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (relative) => readFileSync(join(root, relative), 'utf8');

const problems = [];
const expect = (condition, message) => {
  if (!condition) problems.push(message);
};

const config = JSON.parse(read('apps/desktop/electron-builder.json'));
const pkg = JSON.parse(read('apps/desktop/package.json'));
const mainSource = read('apps/desktop/src/main/electron-main.ts');

expect(config.asar === true, 'packaging must keep ASAR enabled');
expect(config.appId === 'com.idcp.desktop', 'unexpected application id');

for (const platform of ['win', 'mac', 'linux']) {
  const target = config[platform]?.target;
  expect(Array.isArray(target) && target.length > 0, `no ${platform} targets configured`);
}

expect(
  pkg.main === 'dist-electron/electron-main.js',
  'package.json main must point at the compiled main process',
);
expect(
  config.extraMetadata?.main === pkg.main,
  'extraMetadata.main and package.json main must agree, or the packaged app starts the wrong file',
);
expect(
  (config.files ?? []).includes('dist/**/*') && (config.files ?? []).includes('dist-electron/**/*'),
  'packaging must include both the renderer and main process builds',
);
expect(
  pkg.scripts?.['build:electron'] !== undefined,
  'a build:electron script must compile the main process',
);

expect(
  /contextIsolation:\s*true/.test(mainSource),
  'contextIsolation must be true in the BrowserWindow webPreferences',
);
expect(
  /nodeIntegration:\s*false/.test(mainSource),
  'nodeIntegration must be false in the BrowserWindow webPreferences',
);
expect(/sandbox:\s*true/.test(mainSource), 'the renderer must be sandboxed');
expect(!/nodeIntegration:\s*true/.test(mainSource), 'the renderer must never get Node access');

if (problems.length > 0) {
  console.error('Packaging configuration is not valid:');
  for (const problem of problems) console.error(`  - ${problem}`);
  process.exit(1);
}

console.log('Packaging configuration is valid (win, mac, linux; ASAR; isolated renderer).');
