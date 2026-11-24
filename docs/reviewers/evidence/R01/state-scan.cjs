/* eslint-disable @typescript-eslint/no-require-imports -- Standalone CommonJS evidence script. */
// Candidate-finding aid only: this does not enumerate closure, library, OS or dynamic state.
const fs = require('node:fs');
const cp = require('node:child_process');
const ts = require('typescript');
const files = cp
  .execFileSync('git', ['ls-files', 'apps/backend/src'], { encoding: 'utf8' })
  .trim()
  .split('\n')
  .filter((file) => /\.(ts|tsx|js|jsx)$/.test(file));
const result = [];
for (const file of files) {
  const source = ts.createSourceFile(
    file,
    fs.readFileSync(file, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
    file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const loc = (node) => `${file}:${source.getLineAndCharacterOfPosition(node.getStart()).line + 1}`;
  const isCollection = (node) =>
    node &&
    ((ts.isNewExpression(node) &&
      ts.isIdentifier(node.expression) &&
      ['Map', 'Set', 'WeakMap', 'WeakSet'].includes(node.expression.text)) ||
      ts.isArrayLiteralExpression(node) ||
      ts.isObjectLiteralExpression(node));
  for (const statement of source.statements) {
    if (ts.isVariableStatement(statement)) {
      const mutable = (statement.declarationList.flags & ts.NodeFlags.Const) === 0;
      for (const decl of statement.declarationList.declarations) {
        if (mutable || isCollection(decl.initializer))
          result.push(
            `${loc(decl)} module ${mutable ? 'mutable' : 'const collection'} ${decl.name.getText(source)}`,
          );
      }
    }
    if (ts.isClassDeclaration(statement)) {
      for (const member of statement.members) {
        if (ts.isPropertyDeclaration(member) && (member.initializer || member.type)) {
          const signature = member.getText(source).replace(/\s+/g, ' ');
          if (/\b(Map|Set|WeakMap|WeakSet|Timeout|Promise|Array)\b|\[\]/.test(signature)) {
            result.push(
              `${loc(member)} field ${statement.name?.text ?? '(anonymous)'}.${member.name.getText(source)}`,
            );
          }
        }
      }
    }
  }
}
process.stdout.write(
  [
    'R01 backend process-state candidate scan; source baseline ' +
      cp.execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
    `Tracked backend src files: ${files.length}; candidates: ${result.length}`,
    'Module mutable/collection declarations and class fields mentioning selected collection, timer or promise types.',
    'Candidates may be constants, scoped adapters, test utilities, or runtime state; they require manual interpretation.',
    'Nested closures, plain scalar fields, caches in external packages, dynamic state, network/OS state and files outside backend src are not enumerated.',
    '',
    ...result,
  ].join('\n') + '\n',
);
