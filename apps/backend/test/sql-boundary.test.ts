import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import ts from 'typescript';

/** Detect SQL statements in literal strings without flagging comments or ordinary prose.
 * This is a regression check, not a proof against dynamically assembled SQL. */
function literalSqlLocations(text: string, path: string): number[] {
  const file = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true);
  const lines: number[] = [];
  const sql =
    /\b(?:SELECT\s+[\s\S]+?\s+FROM\b|INSERT\s+INTO\b|UPDATE\s+[\w.]+\s+SET\b|DELETE\s+FROM\b|LOCK\s+TABLE\b)/i;
  function visit(node: ts.Node): void {
    let literal: string | undefined;
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      literal = node.text;
    } else if (ts.isTemplateExpression(node)) {
      literal = node.head.text + node.templateSpans.map((span) => ' ' + span.literal.text).join('');
    }
    if (literal && sql.test(literal)) {
      lines.push(file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1);
    }
    ts.forEachChild(node, visit);
  }
  visit(file);
  return lines;
}

describe('backend SQL boundary', () => {
  it('detects literal SQL and interpolated SQL without flagging comments', () => {
    expect(
      literalSqlLocations(
        "// SELECT * FROM examples\nconst text = 'select an option';",
        'example.ts',
      ),
    ).toEqual([]);
    expect(
      literalSqlLocations(
        "const a = 'DELETE FROM examples';\nconst b = `SELECT id FROM ${table}`;",
        'example.ts',
      ),
    ).toEqual([1, 2]);
  });

  it('keeps literal SQL inside repositories and db modules', () => {
    const root = join(__dirname, '../src');
    const violations: string[] = [];
    function inspect(directory: string): void {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) {
          if (directory === root && (entry.name === 'db' || entry.name === 'repositories'))
            continue;
          inspect(path);
        } else if (entry.name.endsWith('.ts')) {
          for (const line of literalSqlLocations(readFileSync(path, 'utf8'), path)) {
            violations.push(`${relative(root, path)}:${line}`);
          }
        }
      }
    }
    inspect(root);
    expect(violations).toEqual([]);
  });
});
