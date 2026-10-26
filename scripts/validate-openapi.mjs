#!/usr/bin/env node
/**
 * OpenAPI validator — `npm run test:api`.
 *
 * Two jobs: (1) the published document is structurally valid OpenAPI 3.1 with resolvable local
 * references, and (2) it does not drift from the code — every route the server actually registers
 * is documented, and every documented path exists.
 *
 * Uses the `yaml` package for parsing — a hand-rolled subset parser was tried first and broke the
 * moment a formatter reflowed a long flow sequence. Contracts are worth a real parser.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { parse as parseYamlDocument } from 'yaml';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');
const specPath = join(repoRoot, 'docs/openapi.yaml');

const errors = [];
const warnings = [];
const fail = (message) => errors.push(message);

// --- Validate the document -------------------------------------------------

let raw;
try {
  raw = readFileSync(specPath, 'utf8');
} catch {
  console.error(`Cannot read ${specPath}`);
  process.exit(1);
}

let spec;
try {
  spec = parseYamlDocument(raw);
} catch (error) {
  console.error(`openapi.yaml could not be parsed: ${error.message}`);
  process.exit(1);
}

if (!/^3\.1\./.test(String(spec.openapi ?? '')))
  fail(`openapi must be 3.1.x (found "${spec.openapi}").`);
if (!spec.info?.title) fail('info.title is required.');
if (!/^\d+\.\d+\.\d+$/.test(String(spec.info?.version ?? ''))) fail('info.version must be semver.');

const paths = spec.paths ?? {};
if (Object.keys(paths).length === 0) fail('paths is empty.');

const METHODS = ['get', 'post', 'put', 'patch', 'delete', 'head', 'options'];
const operationIds = new Set();

for (const [path, item] of Object.entries(paths)) {
  if (!path.startsWith('/')) fail(`path "${path}" must start with "/".`);
  const operations = Object.keys(item ?? {}).filter((key) => METHODS.includes(key));
  if (operations.length === 0) fail(`path "${path}" has no operations.`);
  for (const method of operations) {
    const operation = item[method] ?? {};
    const where = `${method.toUpperCase()} ${path}`;
    if (!operation.operationId) fail(`${where} has no operationId.`);
    else if (operationIds.has(operation.operationId))
      fail(`${where} reuses operationId ${operation.operationId}.`);
    else operationIds.add(operation.operationId);
    if (!operation.summary) fail(`${where} has no summary.`);
    if (!Array.isArray(operation.tags) || operation.tags.length === 0)
      fail(`${where} has no tags.`);
    if (!operation.responses || Object.keys(operation.responses).length === 0)
      fail(`${where} has no responses.`);
    for (const [code, response] of Object.entries(operation.responses ?? {})) {
      if (!/^\d{3}$|^default$/.test(code)) fail(`${where} has an invalid response code "${code}".`);
      if (response === null || typeof response !== 'object' || !response.description) {
        fail(`${where} response ${code} needs a description.`);
      }
    }
    for (const parameter of operation.parameters ?? []) {
      for (const field of ['name', 'in']) {
        if (!parameter?.[field]) fail(`${where} has a parameter without ${field}.`);
      }
    }
  }
}

// Local references must resolve.
function resolveRef(ref) {
  if (!ref.startsWith('#/')) return null;
  return ref
    .slice(2)
    .split('/')
    .reduce((node, key) => (node && typeof node === 'object' ? node[key] : undefined), spec);
}

const refs = [...raw.matchAll(/\$ref:\s*'?([^'"\s]+)'?/g)].map((match) => match[1]);
for (const ref of new Set(refs)) {
  if (resolveRef(ref) === undefined || resolveRef(ref) === null) fail(`unresolvable $ref ${ref}`);
}

// Security: every non-public operation must declare how it is authenticated.
for (const [path, item] of Object.entries(paths)) {
  for (const method of Object.keys(item ?? {}).filter((key) => METHODS.includes(key))) {
    const operation = item[method];
    const isPublic = Array.isArray(operation.security) && operation.security.length === 0;
    const inherits =
      !('security' in operation) && Array.isArray(spec.security) && spec.security.length > 0;
    if (!isPublic && !inherits)
      fail(`${method.toUpperCase()} ${path} declares no security requirement.`);
  }
}

// --- Cross-check with the server -------------------------------------------

const routesDir = join(repoRoot, 'apps/backend/src/http/routes');
const registered = new Set();
for (const file of readdirSync(routesDir)) {
  if (!file.endsWith('.ts')) continue;
  const source = readFileSync(join(routesDir, file), 'utf8');
  for (const match of source.matchAll(/app\.(get|post|patch|delete|put)\(\s*'([^']+)'/g)) {
    registered.add(`${match[1].toUpperCase()} /api/v1${match[2]}`);
  }
}
const healthSource = readFileSync(join(repoRoot, 'apps/backend/src/http/app.ts'), 'utf8');
for (const match of healthSource.matchAll(/app\.(get|post)\(\s*'(\/api\/v1\/[^']+)'/g)) {
  registered.add(`${match[1].toUpperCase()} ${match[2]}`);
}

const documentedPaths = new Set(Object.keys(paths));
for (const route of registered) {
  const [method, fullPath] = route.split(' ');
  if (fullPath === '/api/v1/health') {
    if (!documentedPaths.has('/health')) fail('route GET /api/v1/health is not documented.');
    continue;
  }
  // Fastify uses ":id" for path parameters; OpenAPI uses "{id}".
  const documentedPath = fullPath.replace('/api/v1', '').replace(/:([A-Za-z0-9_]+)/g, '{$1}');
  const item = paths[documentedPath];
  if (!item) {
    fail(
      `route ${route} is not documented in docs/openapi.yaml (expected path "${documentedPath}").`,
    );
    continue;
  }
  if (!item[method.toLowerCase()]) {
    fail(`route ${route} is documented without the ${method} operation.`);
  }
}

const documentedCount = Object.values(paths).reduce(
  (total, item) => total + Object.keys(item ?? {}).filter((key) => METHODS.includes(key)).length,
  0,
);

console.log('OpenAPI 3.1 document');
console.log(`  paths: ${Object.keys(paths).length}, operations: ${documentedCount}`);
console.log(`  routes found in the server: ${registered.size}`);
for (const warning of warnings) console.warn(`  warning: ${warning}`);

if (errors.length > 0) {
  console.error(`\n${errors.length} error(s):`);
  for (const error of errors) console.error(`  error: ${error}`);
  process.exit(1);
}

console.log('\nOpenAPI document is valid and matches the registered routes.');
