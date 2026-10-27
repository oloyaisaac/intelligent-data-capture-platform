#!/usr/bin/env node
/**
 * Legal pack contract — `npm run test:legal`.
 *
 * The documents in `legal/` are published by the API and promised to customers, so they are checked
 * like code: every file exists, the placeholders a deployment must fill are present (so they cannot
 * ship half-edited), and the numbers that describe retention match the configuration defaults.
 *
 * Deterministic, no network, no dependencies.
 */

import { readFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');
const legalDir = join(repoRoot, 'legal');

const errors = [];
const warnings = [];

const REQUIRED = {
  'PRIVACY.md': {
    mustMention: ['Data Protection and Privacy Act', 'Uganda', 'erase', 'retention'],
  },
  'TERMS.md': { mustMention: ['Governing law', 'Acceptable use', 'Liability'] },
  'DPA.md': { mustMention: ['processor', 'controller', 'sub-processor', 'breach'] },
  'SUBPROCESSORS.md': { mustMention: ['Local OCR', 'notice'] },
  'SECURITY.md': { mustMention: ['Rate limiting', 'tenant', 'vulnerability'] },
  'README.md': { mustMention: ['PLACEHOLDER'] },
};

const PLACEHOLDERS = {
  'PRIVACY.md': [
    '[COMPANY NAME]',
    '[ADDRESS]',
    '[REGISTRATION NO.]',
    '[PRIVACY EMAIL]',
    '[EFFECTIVE DATE]',
  ],
  'TERMS.md': [
    '[COMPANY NAME]',
    '[ADDRESS]',
    '[REGISTRATION NO.]',
    '[SUPPORT EMAIL]',
    '[EFFECTIVE DATE]',
    '[GOVERNING LAW]',
  ],
  'DPA.md': ['[COMPANY NAME]', '[ADDRESS]', '[REGISTRATION NO.]', '[EFFECTIVE DATE]'],
};

for (const [file, rules] of Object.entries(REQUIRED)) {
  const path = join(legalDir, file);
  if (!existsSync(path)) {
    errors.push(`${file} is missing from legal/`);
    continue;
  }
  const text = readFileSync(path, 'utf8');
  if (text.trim().length < 500) errors.push(`${file} is suspiciously short.`);
  for (const phrase of rules.mustMention) {
    if (!text.toLowerCase().includes(phrase.toLowerCase())) {
      errors.push(`${file} does not mention "${phrase}".`);
    }
  }
  // Only the documents that name the contracting entity carry the entity placeholders.
  for (const placeholder of PLACEHOLDERS[file] ?? []) {
    if (!text.includes(placeholder)) {
      warnings.push(`${file} does not contain the placeholder ${placeholder}.`);
    }
  }
}

// Retention promises must match the shipped defaults, or the policy becomes a lie the moment
// somebody reads the code.
const privacy = existsSync(join(legalDir, 'PRIVACY.md'))
  ? readFileSync(join(legalDir, 'PRIVACY.md'), 'utf8')
  : '';
const config = readFileSync(join(repoRoot, 'apps/backend/src/config.ts'), 'utf8');
const exportsMatch = /EXPORTS_TTL_SECONDS: IntFromString\((\d+) \* 24 \* 60 \* 60/.exec(config);
if (!exportsMatch) {
  errors.push('Could not read EXPORTS_TTL_SECONDS from apps/backend/src/config.ts.');
} else {
  const days = Number(exportsMatch[1]);
  if (!privacy.includes(`${days} days`)) {
    errors.push(`PRIVACY.md does not state the ${days}-day export retention from the config.`);
  }
}
if (!/retention_days[^\n]*90|90 days/.test(privacy + config)) {
  warnings.push('PRIVACY.md should state the default 90-day document retention.');
}

// The API serves exactly these slugs; a document without a route is unreadable, and a route without
// a document is a 404 in production.
const routes = readFileSync(join(repoRoot, 'apps/backend/src/http/routes/legal-routes.ts'), 'utf8');
for (const file of Object.keys(REQUIRED)) {
  if (file === 'README.md') continue;
  const slug = file.replace('.md', '').toLowerCase();
  if (!routes.includes(`'${slug}'`)) {
    errors.push(`legal/${file} is not served by a slug in legal-routes.ts.`);
  }
}

// The contract must not name a provider the sub-processor list does not carry: that is the gap a
// customer's procurement reviewer finds, and it is invisible in either document alone.
const dpaPath = join(legalDir, 'DPA.md');
const subPath = join(legalDir, 'SUBPROCESSORS.md');
if (existsSync(dpaPath) && existsSync(subPath)) {
  const dpa = readFileSync(dpaPath, 'utf8');
  const subprocessors = readFileSync(subPath, 'utf8');
  if (!dpa.includes('SUBPROCESSORS.md')) {
    errors.push('DPA.md does not point at SUBPROCESSORS.md.');
  }
  const providerPlaceholders =
    /\[(?:HOSTING PROVIDER|CLOUD AI PROVIDER|EMAIL PROVIDER|ERROR TRACKING)\]/g;
  for (const match of dpa.matchAll(providerPlaceholders)) {
    if (!subprocessors.includes(match[0])) {
      errors.push(`DPA.md names ${match[0]}, which SUBPROCESSORS.md does not list.`);
    }
  }
  // A row added to the table without a purpose column reads as an oversight, not a decision.
  const rows = (subprocessors.match(/^\|\s*\d+\s*\|/gm) ?? []).length;
  if (rows < 3) errors.push('SUBPROCESSORS.md has fewer than three numbered rows.');
}

for (const warning of warnings) console.warn(`  warning: ${warning}`);

if (errors.length > 0) {
  console.error(`\n${errors.length} error(s):`);
  for (const error of errors) console.error(`  error: ${error}`);
  process.exit(1);
}

console.log(
  `Legal pack is consistent: ${Object.keys(REQUIRED).length} documents, placeholders intact.`,
);
