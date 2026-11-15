#!/usr/bin/env node
/**
 * Checks the desktop packaging configuration (DESK-001).
 *
 * This check validates the packaging contract statically: platform targets, ASAR enabled, the
 * built main-process entry point, baked API configuration, the secure renderer scheme, and no
 * browser window that hands Node to the renderer. It is not evidence that a native installer
 * launches; that requires the Electron binary and a packaged-runtime smoke test.
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
const rendererHtml = read('apps/desktop/index.html');
const viteConfig = read('apps/desktop/vite.config.ts');

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
  typeof pkg.devDependencies?.electron === 'string',
  'Electron must be a declared build dependency; electron-builder alone cannot produce a runnable app',
);
expect(
  typeof pkg.devDependencies?.['electron-builder'] === 'string',
  'electron-builder must be a declared dependency so packaging is reproducible',
);
expect(
  pkg.scripts?.['build:electron']?.includes('configure-desktop-api.mjs'),
  'build:electron must generate the baked API configuration consumed by the main process',
);
for (const script of ['package', 'package:win', 'package:mac', 'package:linux']) {
  expect(
    pkg.scripts?.[script]?.includes('configure-desktop-api.mjs --check'),
    `${script} must reject a missing or invalid API_BASE_URL before building`,
  );
}
expect(
  !/http-equiv\s*=\s*["']Content-Security-Policy/i.test(rendererHtml),
  'the packaged HTML must not contain a static meta CSP that intersects with its API-specific header',
);
expect(
  /headers:\s*\{\s*['"]Content-Security-Policy['"]/.test(viteConfig),
  'the development server must set CSP with a response header after the static meta policy is removed',
);
expect(
  /registerSchemesAsPrivileged/.test(mainSource) && /protocol\.handle/.test(mainSource),
  'the packaged app must register and serve its secure custom renderer scheme',
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
