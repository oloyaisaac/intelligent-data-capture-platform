/* eslint-disable @typescript-eslint/no-require-imports -- Standalone CommonJS evidence script. */
// From the repo root after npm ci; static TypeScript resolution, not a runtime or packaging test.
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const cp = require('node:child_process');
const root = process.cwd();
const workspaces = [
  'apps/backend',
  'apps/desktop',
  'apps/mobile',
  'packages/shared',
  'packages/connectors',
];
const manifests = new Map(
  workspaces.map((dir) => [dir, JSON.parse(fs.readFileSync(`${dir}/package.json`, 'utf8'))]),
);
const byName = new Map([...manifests].map(([dir, manifest]) => [manifest.name, dir]));
const files = cp
  .execFileSync('git', ['ls-files', 'apps/*/src/*', 'packages/*/src/*'], { encoding: 'utf8' })
  .trim()
  .split('\n')
  .filter((file) => /\.(ts|tsx|js|jsx)$/.test(file));
const configs = [
  'apps/backend/tsconfig.json',
  'apps/desktop/tsconfig.json',
  'apps/desktop/tsconfig.electron.json',
  'apps/desktop/tsconfig.test.json',
  'apps/mobile/tsconfig.json',
  'packages/shared/tsconfig.json',
  'packages/connectors/tsconfig.json',
];
const opts = new Map();
const lines = [];
for (const configPath of configs) {
  const file = ts.readConfigFile(configPath, ts.sys.readFile);
  if (file.error) throw new Error(ts.flattenDiagnosticMessageText(file.error.messageText, '\n'));
  const parsed = ts.parseJsonConfigFileContent(
    file.config,
    ts.sys,
    path.resolve(path.dirname(configPath)),
  );
  if (parsed.errors.length)
    throw new Error(
      parsed.errors.map((e) => ts.flattenDiagnosticMessageText(e.messageText, '\n')).join('\n'),
    );
  const dir = workspaces.find((name) => configPath.startsWith(name + '/'));
  const manifest = manifests.get(dir);
  const declared = {
    ...manifest.dependencies,
    ...manifest.devDependencies,
    ...manifest.peerDependencies,
    ...manifest.optionalDependencies,
  };
  const aliases = Object.keys(parsed.options.paths || {});
  lines.push(`${configPath}:`);
  for (const name of aliases) {
    const packageName = name.split('/').slice(0, 2).join('/');
    const resolved = ts.resolveModuleName(
      name,
      path.resolve(dir, 'src/__architecture_probe__.ts'),
      parsed.options,
      ts.sys,
    ).resolvedModule;
    const relation =
      packageName === manifest.name ? 'self' : declared[packageName] ? 'declared' : 'NOT DECLARED';
    lines.push(
      `  ${name} -> ${resolved ? path.relative(root, resolved.resolvedFileName).replace(/\\/g, '/') : 'unresolved'} (${relation})`,
    );
  }
  if (configPath === `${dir}/tsconfig.json`) opts.set(dir, parsed.options);
}
const undeclared = [];
const unresolved = [];
let count = 0;
for (const file of files) {
  const dir = workspaces.find((name) => file.startsWith(name + '/'));
  const manifest = manifests.get(dir);
  const declared = {
    ...manifest.dependencies,
    ...manifest.devDependencies,
    ...manifest.peerDependencies,
    ...manifest.optionalDependencies,
  };
  const scriptKind = file.endsWith('.tsx')
    ? ts.ScriptKind.TSX
    : file.endsWith('.jsx')
      ? ts.ScriptKind.JSX
      : file.endsWith('.js')
        ? ts.ScriptKind.JS
        : ts.ScriptKind.TS;
  const source = ts.createSourceFile(
    file,
    fs.readFileSync(file, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
    scriptKind,
  );
  function visit(node) {
    let moduleSpecifier = null;
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier)
      moduleSpecifier = node.moduleSpecifier;
    else if (
      ts.isCallExpression(node) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) && node.expression.text === 'require'))
    )
      moduleSpecifier = node.arguments[0];
    if (moduleSpecifier && ts.isStringLiteralLike(moduleSpecifier)) {
      const name = moduleSpecifier.text;
      const resolved = ts.resolveModuleName(
        name,
        path.join(root, file),
        opts.get(dir),
        ts.sys,
      ).resolvedModule;
      const line = source.getLineAndCharacterOfPosition(node.getStart()).line + 1;
      if (!resolved && name.startsWith('@idcp/')) unresolved.push(`${file}:${line} ${name}`);
      if (resolved) {
        const target = path.relative(root, resolved.resolvedFileName).replace(/\\/g, '/');
        const other = workspaces.find((workspace) => target.startsWith(workspace + '/'));
        if (other && other !== dir) {
          count++;
          const packageName = manifests.get(other).name;
          if (!declared[packageName])
            undeclared.push(`${file}:${line} ${name} -> ${target} (${packageName})`);
        }
      }
      // Unknown @idcp packages are called out even if installed outside the workspace.
      const packageName = name.split('/').slice(0, 2).join('/');
      if (name.startsWith('@idcp/') && !byName.has(packageName))
        unresolved.push(`${file}:${line} unknown workspace ${name}`);
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
}
process.stdout.write(
  [
    'R01 TypeScript path mapping check; source baseline ' +
      cp.execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
    'Inherited alias resolution in seven configs (self is not an external dependency):',
    ...lines,
    '',
    `Tracked workspace src files: ${files.length}; resolved cross-workspace literal import/export/require occurrences: ${count}`,
    `Resolved cross-workspace occurrences without a manifest declaration (${undeclared.length}):`,
    ...undeclared,
    `Unresolved or unknown @idcp literal specifiers (${unresolved.length}):`,
    ...unresolved,
    '',
    'Primary workspace tsconfig used for source imports; alternate desktop configs shown above only. Nonliteral imports, imports outside tracked src, package export/runtime resolution, transitive dependencies and declaration correctness are not proven.',
  ].join('\n') + '\n',
);
