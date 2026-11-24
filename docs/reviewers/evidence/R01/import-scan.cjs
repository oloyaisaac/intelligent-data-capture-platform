/* R01 evidence aid, not a proof of runtime dependency isolation. Run from repository root. */
/* eslint-disable @typescript-eslint/no-require-imports -- This standalone evidence script is CommonJS. */
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const cp = require('node:child_process');
const { builtinModules } = require('node:module');

const root = process.cwd();
const tracked = cp
  .execFileSync('git', ['ls-files', 'apps/*/src/*', 'packages/*/src/*'], { encoding: 'utf8' })
  .trim()
  .split('\n')
  .filter((file) => /\.(ts|tsx|js|jsx)$/.test(file));
const config = ts.readConfigFile('tsconfig.base.json', ts.sys.readFile);
if (config.error) throw new Error(ts.flattenDiagnosticMessageText(config.error.messageText, '\n'));
const options = ts.parseJsonConfigFileContent(config.config, ts.sys, root).options;
const builtins = new Set(builtinModules.flatMap((name) => [name, 'node:' + name]));
const workspace = (value) => {
  const match = value.replace(/\\/g, '/').match(/^(apps|packages)\/([^/]+)\//);
  return match ? `${match[1]}/${match[2]}` : null;
};
const cross = [];
const privileged = [];
const unresolved = [];
const nonliteral = [];
let imports = 0;
for (const file of tracked) {
  const kind = file.endsWith('tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const source = ts.createSourceFile(
    file,
    fs.readFileSync(file, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
    kind,
  );
  function visit(node) {
    let spec = null;
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier) {
      spec = node.moduleSpecifier;
    } else if (
      ts.isCallExpression(node) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) && node.expression.text === 'require'))
    ) {
      spec = node.arguments[0];
      if (!spec || !ts.isStringLiteralLike(spec)) {
        nonliteral.push(
          `${file}:${source.getLineAndCharacterOfPosition(node.getStart()).line + 1} dynamic import/require`,
        );
      }
    }
    if (spec && ts.isStringLiteralLike(spec)) {
      imports += 1;
      const name = spec.text;
      const from = workspace(file);
      const line = source.getLineAndCharacterOfPosition(node.getStart()).line + 1;
      if (
        /^apps\/desktop\/src\/(pages|components|lib)\//.test(file) &&
        (builtins.has(name) || name === 'electron')
      ) {
        privileged.push(`${file}:${line} ${name}`);
      }
      if (!builtins.has(name)) {
        const resolved = ts.resolveModuleName(
          name,
          path.join(root, file),
          options,
          ts.sys,
        ).resolvedModule;
        if (resolved) {
          const destination = path.relative(root, resolved.resolvedFileName).replace(/\\/g, '/');
          const to = workspace(destination);
          if (
            from &&
            to &&
            from !== to &&
            ((from.startsWith('packages/') && to.startsWith('apps/')) ||
              (from.startsWith('apps/') && to.startsWith('apps/')))
          )
            cross.push(`${file}:${line} ${name} -> ${destination}`);
        } else if (name.startsWith('.') || name.startsWith('@idcp/')) {
          unresolved.push(`${file}:${line} ${name}`);
        }
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
}
process.stdout.write(
  [
    'R01 static TS module-specifier review; base commit ' +
      cp.execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
    `Tracked workspace src files: ${tracked.length}; literal specifiers: ${imports}`,
    'Uses TypeScript syntax tree and tsconfig.base.json resolution; nonliteral imports, native modules, test/config files, runtime resolution and correctness remain outside proof.',
    '',
    `Cross app/package-to-app resolved edges (${cross.length}):`,
    ...cross,
    '',
    `Node/electron imports in desktop pages/components/lib (${privileged.length}):`,
    ...privileged,
    '',
    `Unresolved relative/@idcp specifiers (${unresolved.length}):`,
    ...unresolved,
    '',
    `Nonliteral dynamic import/require calls (${nonliteral.length}):`,
    ...nonliteral,
  ].join('\n') + '\n',
);
