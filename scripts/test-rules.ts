import ts from 'typescript';
export function inspectTests(text: string, name: string) {
  const source = ts.createSourceFile(
    name,
    text,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS
  );
  const bindings = new Map<string, string>();
  const namespaces = new Set<string>();
  for (const statement of source.statements) {
    if (
      !ts.isImportDeclaration(statement) ||
      !ts.isStringLiteral(statement.moduleSpecifier) ||
      !['vitest', 'node:test'].includes(statement.moduleSpecifier.text)
    )
      continue;
    const named = statement.importClause?.namedBindings;
    if (named && ts.isNamedImports(named))
      for (const item of named.elements)
        bindings.set(item.name.text, item.propertyName?.text ?? item.name.text);
    if (named && ts.isNamespaceImport(named)) namespaces.add(named.name.text);
  }
  const pathOf = (expression: ts.Expression): string => {
    if (ts.isIdentifier(expression))
      return bindings.get(expression.text) ?? expression.text;
    if (ts.isCallExpression(expression)) return pathOf(expression.expression);
    if (ts.isPropertyAccessExpression(expression))
      return `${pathOf(expression.expression)}.${expression.name.text}`;
    if (
      ts.isElementAccessExpression(expression) &&
      expression.argumentExpression &&
      ts.isStringLiteralLike(expression.argumentExpression)
    )
      return `${pathOf(expression.expression)}.${expression.argumentExpression.text}`;
    return expression.getText(source);
  };
  const violations: Array<{ line: number; rule: string }> = [];
  const fail = (node: ts.Node, rule: string) =>
    violations.push({
      line:
        source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1,
      rule,
    });
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node)) {
      let callee = pathOf(node.expression);
      for (const namespace of namespaces)
        if (callee.startsWith(`${namespace}.`))
          callee = callee.slice(namespace.length + 1);
      if (/^(?:vi|jest)\.(?:mock|fn|spyOn|stub)/.test(callee))
        fail(node, 'no-mock');
      if (/\.(?:only|skip)$/.test(callee)) fail(node, 'no-focused-or-skipped');
      if (/\.(?:toBeTruthy|toBeDefined|toBeFalsy)$/.test(callee))
        fail(node, 'specific-assertions');
      if (/(?:waitForTimeout|setTimeout)$/.test(callee))
        fail(node, 'no-fixed-waits');
      if (/^(?:it|test|describe)(?:$|\.)/.test(callee)) {
        const title = node.arguments[0];
        const callback = node.arguments.at(-1);
        if (
          title &&
          ts.isStringLiteralLike(title) &&
          !title.text.startsWith('user ')
        )
          fail(title, 'user-scenario-name');
        if (
          !callee.startsWith('describe') &&
          callback &&
          (ts.isArrowFunction(callback) || ts.isFunctionExpression(callback))
        ) {
          const body = callback.body.getFullText(source);
          const given = body.indexOf('// Given');
          const when = body.indexOf('// When');
          const then = body.indexOf('// Then');
          if (given < 0 || when <= given || then <= when)
            fail(callback, 'given-when-then');
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return violations;
}
