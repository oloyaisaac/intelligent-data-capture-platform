/* eslint-disable @typescript-eslint/no-require-imports -- Standalone CommonJS evidence probe. */
// Run from repository root after npm ci. Executes the actual transpiled helper in isolation,
// without connecting to a database or creating any data.
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');
const source = fs.readFileSync('apps/backend/src/db/database.ts', 'utf8');
const js = ts.transpile(source, { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 });
const moduleObject = { exports: {} };
vm.runInNewContext(js, { exports: moduleObject.exports, module: moduleObject });
for (const sql of [
  "SELECT '?' AS q, ? AS arg",
  'SELECT $$?$$ AS q, ? AS arg',
  'SELECT 1 -- ? in comment\nWHERE id = ?',
]) {
  process.stdout.write(
    `${JSON.stringify(sql)} -> ${JSON.stringify(moduleObject.exports.toPostgresPlaceholders(sql))}\n`,
  );
}
