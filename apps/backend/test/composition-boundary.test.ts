import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';

/** Static regression check for direct and aliased repository constructors, not a DI proof. */
function repositoryConstructions(text: string, path: string): number[] {
  const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true);
  const aliases = new Set<string>();
  const namespaces = new Set<string>();
  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier))
      continue;
    if (!statement.moduleSpecifier.text.includes('/repositories/')) continue;
    const bindings = statement.importClause?.namedBindings;
    if (bindings && ts.isNamespaceImport(bindings)) namespaces.add(bindings.name.text);
    if (bindings && ts.isNamedImports(bindings)) {
      for (const element of bindings.elements) {
        if ((element.propertyName?.text ?? element.name.text).endsWith('Repository')) {
          aliases.add(element.name.text);
        }
      }
    }
  }
  const lines: number[] = [];
  function visit(node: ts.Node): void {
    if (ts.isNewExpression(node)) {
      const expression = node.expression;
      const direct =
        ts.isIdentifier(expression) &&
        (aliases.has(expression.text) || expression.text.endsWith('Repository'));
      const namespaced =
        ts.isPropertyAccessExpression(expression) &&
        ts.isIdentifier(expression.expression) &&
        namespaces.has(expression.expression.text) &&
        expression.name.text.endsWith('Repository');
      if (direct || namespaced)
        lines.push(source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1);
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  return lines;
}

describe('service composition boundary', () => {
  it('detects direct, aliased and namespace repository construction', () => {
    const code = `import { UsersRepository as Users } from '../repositories/auth-repo';
import * as db from '../repositories/auth-repo';
new Users(connection);
new db.UsersRepository(connection);
new OtherRepository(connection);`;
    expect(repositoryConstructions(code, 'sample.ts')).toEqual([3, 4, 5]);
    expect(repositoryConstructions('// new UsersRepository(db)', 'sample.ts')).toEqual([]);
  });

  it('keeps direct repository construction out of service modules except the composition root', () => {
    const directory = join(__dirname, '../src/services');
    const violations: string[] = [];
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith('.ts') || entry.name === 'container.ts') continue;
      const path = join(directory, entry.name);
      for (const line of repositoryConstructions(readFileSync(path, 'utf8'), path)) {
        violations.push(`${entry.name}:${line}`);
      }
    }
    expect(violations).toEqual([]);
  });
});
