import { describe, expect, it } from 'vitest';
import { inspectTests } from '../scripts/test-rules.js';

// These are syntax-boundary fixtures protecting governance from alias and string-literal bypasses.
describe('user keeps test governance effective after harmless import renaming', () => {
  it('user detects an aliased mock and a missing acceptance scenario', () => {
    // Given test syntax that aliases both the test runner and mock namespace.
    const source =
      'import { it as scenario, vi as helper } from "vitest"; scenario("internal", () => { helper["fn"](); });';
    // When governance inspects the syntax through imported bindings.
    const rules = inspectTests(source, 'fixture.test.ts').map(
      (violation) => violation.rule
    );
    // Then changing names cannot bypass mock and scenario requirements.
    expect(rules).toContain('no-mock');
    expect(rules).toContain('user-scenario-name');
    expect(rules).toContain('given-when-then');
  });
  it('user does not reject quoted documentation examples as executable mocks', () => {
    // Given a valid acceptance test containing a quoted mock example.
    const source =
      'import { it } from "vitest"; it("user reads documentation", () => {\n// Given text\nconst example = "vi.fn()";\n// When displayed\nconst shown = example;\n// Then checked\nexpect(shown).toBe("vi.fn()");\n});';
    // When governance parses actual AST calls rather than matching raw source.
    const violations = inspectTests(source, 'fixture.test.ts');
    // Then documentation text does not produce a false violation.
    expect(violations).toEqual([]);
  });
  it('user detects namespace-imported focused tests', () => {
    // Given a namespace import that focuses one test.
    const source =
      'import * as suite from "vitest"; suite.it.only("user tests one case", () => {\n// Given data\n// When checked\n// Then observed\n});';
    // When governance resolves the namespace path.
    const rules = inspectTests(source, 'fixture.test.ts').map(
      (violation) => violation.rule
    );
    // Then the focus cannot silently exclude the rest of the suite.
    expect(rules).toContain('no-focused-or-skipped');
  });
});
