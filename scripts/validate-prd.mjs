#!/usr/bin/env node
/**
 * PRD validator — `npm run test:prd`.
 *
 * The PRD is the contract for what gets built, so it is checked like code: identifiers are unique,
 * every reference resolves, statuses come from the agreed legend and are consistent with the
 * dependencies (a story cannot be "done" while something it depends on is not), and every declared
 * artifact actually exists in the repository.
 *
 * Errors fail the run; warnings are reported but do not. Deterministic, no network, no deps.
 */

import { readFileSync, existsSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');
const prdPath = join(repoRoot, 'PRD.json');

const errors = [];
const warnings = [];

function fail(message) {
  errors.push(message);
}

function warn(message) {
  warnings.push(message);
}

function readPrd() {
  let raw;
  try {
    raw = readFileSync(prdPath, 'utf8');
  } catch {
    console.error(`Cannot read ${prdPath}`);
    process.exit(1);
  }
  try {
    return JSON.parse(raw);
  } catch (error) {
    console.error(`PRD.json is not valid JSON: ${error.message}`);
    process.exit(1);
  }
}

const prd = readPrd();

// --- Shape -----------------------------------------------------------------

const requiredTopLevel = [
  'project',
  'slug',
  'version',
  'lastUpdated',
  'epics',
  'stories',
  'statusLegend',
];
for (const key of requiredTopLevel) {
  if (!(key in prd)) fail(`PRD.json is missing the "${key}" field.`);
}

if (!Array.isArray(prd.epics) || prd.epics.length === 0)
  fail('PRD.json must declare at least one epic.');
if (!Array.isArray(prd.stories) || prd.stories.length === 0)
  fail('PRD.json must declare at least one story.');

if (!/^\d+\.\d+\.\d+$/.test(String(prd.version ?? ''))) {
  fail(`version "${prd.version}" is not semver (expected x.y.z).`);
}

const lastUpdated = new Date(String(prd.lastUpdated));
if (Number.isNaN(lastUpdated.getTime())) {
  fail(`lastUpdated "${prd.lastUpdated}" is not a date.`);
} else if (lastUpdated.getTime() > Date.now() + 24 * 60 * 60 * 1000) {
  fail('lastUpdated is in the future.');
}

// --- Schema reference ------------------------------------------------------

if (prd.$schema && !/^https?:\/\//.test(prd.$schema)) {
  const schemaPath = join(repoRoot, prd.$schema);
  if (!existsSync(schemaPath)) {
    fail(`$schema points at "${prd.$schema}", which does not exist in the repository.`);
  } else {
    try {
      const schema = JSON.parse(readFileSync(schemaPath, 'utf8'));
      if (!schema.$id && !schema.$schema) {
        fail(`$schema "${prd.$schema}" is JSON but not a JSON Schema (no $id or $schema).`);
      }
      if (schema.title === undefined && schema.type === undefined) {
        fail(`$schema "${prd.$schema}" describes nothing (no title, no type).`);
      }
    } catch (error) {
      fail(`$schema "${prd.$schema}" is not valid JSON: ${error.message}`);
    }
  }
}

// --- Epics -----------------------------------------------------------------

const epicIds = new Set();
for (const [index, epic] of (prd.epics ?? []).entries()) {
  const where = `epics[${index}]`;
  if (!epic.id) fail(`${where} has no id.`);
  else if (epicIds.has(epic.id)) fail(`${where} duplicates the epic id ${epic.id}.`);
  else epicIds.add(epic.id);

  for (const field of ['title', 'description']) {
    if (!epic[field] || String(epic[field]).trim().length === 0)
      fail(`${where} (${epic.id}) has no ${field}.`);
  }
  if (!Number.isInteger(epic.phase) || epic.phase < 1)
    fail(`${where} (${epic.id}) has an invalid phase.`);
}

// --- Statuses --------------------------------------------------------------

const statuses = new Set(Object.keys(prd.statusLegend ?? {}));
if (statuses.size === 0) fail('statusLegend is empty, so no story status can be validated.');
const priorities = new Set(['must', 'should', 'could', 'wont']);

// --- Stories ---------------------------------------------------------------

const storyIds = new Set();
const stories = prd.stories ?? [];

for (const [index, story] of stories.entries()) {
  const where = `stories[${index}] (${story.id ?? 'no id'})`;

  if (!story.id) {
    fail(`${where} has no id.`);
    continue;
  }
  if (storyIds.has(story.id)) fail(`${where} duplicates a story id.`);
  storyIds.add(story.id);

  if (!/^[A-Z][A-Z0-9]*-\d{3}$/.test(story.id)) {
    warn(`${where}: id does not follow the EPIC-000 convention.`);
  }

  if (!story.epic) fail(`${where} has no epic.`);
  else if (!epicIds.has(story.epic)) fail(`${where} references the unknown epic ${story.epic}.`);

  if (!statuses.has(story.status))
    fail(`${where} has status "${story.status}", which is not in statusLegend.`);

  if (!priorities.has(story.priority))
    fail(`${where} has priority "${story.priority}", which is unknown.`);

  if (!Number.isInteger(story.phase) || story.phase < 1) fail(`${where} has an invalid phase.`);

  for (const field of ['title', 'description']) {
    if (!story[field] || String(story[field]).trim().length === 0)
      fail(`${where} has no ${field}.`);
  }

  if (!Array.isArray(story.acceptanceCriteria) || story.acceptanceCriteria.length === 0) {
    fail(`${where} has no acceptance criteria.`);
  } else {
    story.acceptanceCriteria.forEach((criterion, criterionIndex) => {
      if (typeof criterion !== 'string' || criterion.trim().length < 10) {
        warn(`${where} acceptance criterion ${criterionIndex + 1} is very short.`);
      }
    });
  }

  if (!Array.isArray(story.dependsOn)) {
    fail(`${where} has no dependsOn array.`);
  } else {
    for (const dependency of story.dependsOn) {
      if (dependency === story.id) fail(`${where} depends on itself.`);
      else if (!(prd.stories ?? []).some((candidate) => candidate.id === dependency)) {
        fail(`${where} depends on the unknown story ${dependency}.`);
      }
    }
  }

  if (!Array.isArray(story.artifacts)) {
    fail(`${where} has no artifacts array.`);
  } else {
    for (const artifact of story.artifacts) {
      if (typeof artifact !== 'string' || artifact.trim().length === 0) {
        fail(`${where} lists an empty artifact.`);
        continue;
      }
      if (artifact.includes('..')) {
        fail(`${where} artifact "${artifact}" escapes the repository.`);
        continue;
      }
      const isGlob = artifact.includes('*');
      const absolute = join(repoRoot, artifact.replace(/\/$/, ''));
      if (isGlob) {
        // Glob artifacts are checked by their parent directory, which must exist.
        const parent = join(repoRoot, artifact.split('*')[0].replace(/\/$/, ''));
        if (!existsSync(parent))
          warn(`${where}: artifact pattern "${artifact}" has no matching directory.`);
        continue;
      }
      if (!existsSync(absolute)) {
        warn(`${where}: artifact "${artifact}" does not exist yet.`);
      } else if (statSync(absolute).isDirectory() && artifact.endsWith('.ts')) {
        fail(`${where}: artifact "${artifact}" is a directory but looks like a file.`);
      }
    }
  }

  // A `verification` block records what a reader should not assume about a done story. It is not
  // optional decoration: an empty one is worse than none, so it is checked.
  if (story.verification !== undefined) {
    const block = story.verification;
    if (typeof block !== 'object' || block === null || Array.isArray(block)) {
      fail(`${where}: verification must be an object.`);
    } else {
      for (const key of Object.keys(block)) {
        if (!['notVerified', 'evidence'].includes(key)) {
          fail(`${where}: verification has an unknown key "${key}".`);
        }
      }
      if (!Array.isArray(block.notVerified) || block.notVerified.length === 0) {
        fail(`${where}: verification.notVerified must list at least one caveat.`);
      } else {
        block.notVerified.forEach((entry, entryIndex) => {
          if (typeof entry !== 'string' || entry.trim().length < 10) {
            fail(`${where}: verification.notVerified[${entryIndex}] is not a sentence.`);
          }
        });
      }
      if (block.evidence !== undefined) {
        if (!Array.isArray(block.evidence) || block.evidence.length === 0) {
          fail(`${where}: verification.evidence must be a non-empty array when present.`);
        } else {
          for (const path of block.evidence) {
            if (typeof path !== 'string' || path.trim().length === 0) {
              fail(`${where}: verification.evidence has an empty entry.`);
              continue;
            }
            const target = join(repoRoot, path.split('#')[0]);
            if (!existsSync(target)) {
              warn(`${where}: verification.evidence "${path}" does not exist.`);
            }
          }
        }
      }
    }
  }

  // A story cannot be done while a prerequisite is untouched. A prerequisite that is still
  // in progress is a warning: the parts this story needs may already be in place.
  if (story.status === 'done') {
    for (const dependency of story.dependsOn ?? []) {
      const target = stories.find((candidate) => candidate.id === dependency);
      if (!target || target.status === 'done') continue;
      if (target.status === 'in_progress') {
        warn(`${where} is done while ${dependency} is still in progress.`);
      } else {
        fail(`${where} is done but depends on ${dependency}, which is ${target.status}.`);
      }
    }
  }
}

// --- Epics must own stories ------------------------------------------------

const epicStoryCount = new Map([...epicIds].map((id) => [id, 0]));
for (const story of stories) {
  if (epicStoryCount.has(story.epic))
    epicStoryCount.set(story.epic, epicStoryCount.get(story.epic) + 1);
}
for (const [id, count] of epicStoryCount) {
  if (count === 0) warn(`Epic ${id} has no stories.`);
}

// --- Milestones ------------------------------------------------------------

const milestoneIds = new Set();
for (const milestone of prd.milestones ?? []) {
  if (!milestone.id) fail('A milestone has no id.');
  else if (milestoneIds.has(milestone.id)) fail(`Duplicate milestone id ${milestone.id}.`);
  else milestoneIds.add(milestone.id);
  if (!statuses.has(milestone.status)) {
    fail(
      `Milestone ${milestone.id} has status "${milestone.status}", which is not in statusLegend.`,
    );
  }
}

// --- Open questions --------------------------------------------------------

for (const question of prd.openQuestions ?? []) {
  if (!question.id) fail('An open question has no id.');
  if (!question.question) fail(`Open question ${question.id} has no text.`);
  if (question.status === 'open') warn(`Open question ${question.id} is still unanswered.`);
}

// --- Report ----------------------------------------------------------------

const done = stories.filter((story) => story.status === 'done').length;
const inProgress = stories.filter((story) => story.status === 'in_progress').length;
const pending = stories.filter((story) => story.status === 'pending').length;

console.log(`PRD ${prd.version} (${prd.project})`);
console.log(`  epics:  ${epicIds.size}`);
console.log(
  `  stories: ${stories.length} — done ${done}, in progress ${inProgress}, pending ${pending}`,
);
console.log(`  open questions: ${(prd.openQuestions ?? []).length}`);
const withCaveats = stories.filter((story) => story.verification !== undefined).length;
if (withCaveats > 0) {
  console.log(`  done stories with recorded caveats: ${withCaveats}`);
}

for (const warning of warnings) console.warn(`  warning: ${warning}`);

if (errors.length > 0) {
  console.error(`\n${errors.length} error(s):`);
  for (const error of errors) console.error(`  error: ${error}`);
  process.exit(1);
}

console.log('\nPRD is valid.');
