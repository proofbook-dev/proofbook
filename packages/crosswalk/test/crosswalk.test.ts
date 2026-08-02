import { describe, expect, it } from "vitest";
import {
  CrosswalkError,
  ExpressionError,
  loadCrosswalkDir,
  loadCrosswalkText,
  loadEquivalence,
  parseExpression,
} from "../src/index.js";

describe("the published EU AI Act crosswalk", () => {
  it("loads, validates and pins by content hash", async () => {
    const frameworks = await loadCrosswalkDir();
    const eu = frameworks.get("eu-ai-act");
    expect(eu).toBeDefined();
    expect(eu!.doc.controls).toHaveLength(13);
    expect(eu!.pin).toMatch(/^sha256:[0-9a-f]{64}$/);

    const again = await loadCrosswalkDir();
    expect(again.get("eu-ai-act")!.pin).toBe(eu!.pin);
  });

  it("declares a source class on every assertion, with the expected mix", async () => {
    const frameworks = await loadCrosswalkDir();
    const assertions = frameworks
      .get("eu-ai-act")!
      .doc.controls.flatMap((c) => c.assertions);

    const byClass = Object.groupBy(assertions, (a) => a.source_class);
    expect(byClass.observed?.length).toBe(11);
    expect(byClass.declared?.length).toBe(4);
    expect(byClass.configured?.length).toBe(1);

    for (const a of assertions) {
      if (a.source_class === "observed") expect(a.capability).toBeDefined();
    }
  });

  it("maps no_data to unevaluable on every assertion, structurally", async () => {
    const frameworks = await loadCrosswalkDir();
    for (const control of frameworks.get("eu-ai-act")!.doc.controls) {
      for (const assertion of control.assertions) {
        expect(assertion.verdict_map.no_data).toBe("unevaluable");
      }
    }
  });

  it("validates the equivalence map against loaded frameworks", async () => {
    const frameworks = await loadCrosswalkDir();
    const eq = await loadEquivalence(frameworks);
    expect(eq.equivalences.length).toBeGreaterThanOrEqual(4);
  });
});

describe("expression grammar", () => {
  it("parses the function set used by the shipped crosswalk", () => {
    const coverage = parseExpression(
      "coverage(AgentRun, [run_id, agent_id, started_at, ended_at]) >= 0.99",
    );
    expect(coverage).toMatchObject({
      fn: "coverage",
      comparator: { op: ">=", value: 0.99 },
    });
    expect(coverage.args[0]).toMatchObject({ kind: "selector", eventType: "AgentRun" });
    expect(coverage.args[1]).toMatchObject({
      kind: "fields",
      fields: ["run_id", "agent_id", "started_at", "ended_at"],
    });

    const ratio = parseExpression("ratio(ModelCall[linked(AgentRun)], ModelCall) >= 0.99");
    expect(ratio.args[0]).toMatchObject({
      kind: "selector",
      eventType: "ModelCall",
      filter: { kind: "linked", eventType: "AgentRun" },
    });

    expect(parseExpression("declared(ai_interaction_disclosure)")).toMatchObject({
      fn: "declared",
      args: [{ kind: "ident", name: "ai_interaction_disclosure" }],
    });
  });

  it("rejects unknown functions, unknown event types and malformed selectors", () => {
    expect(() => parseExpression("summon(AgentRun)")).toThrow(ExpressionError);
    expect(() => parseExpression("exists(FluxCapacitor)")).toThrow(ExpressionError);
    expect(() => parseExpression("ratio(ModelCall[linked(Nothing)], ModelCall) >= 1")).toThrow(
      ExpressionError,
    );
    expect(() => parseExpression("coverage(AgentRun [run_id]) >= 0.5")).toThrow(ExpressionError);
  });

  it("enforces comparator rules per function", () => {
    // Numeric functions without a threshold are meaningless...
    expect(() => parseExpression("coverage(AgentRun, [run_id])")).toThrow(ExpressionError);
    // ...and boolean functions with one are a category error.
    expect(() => parseExpression("exists(AgentRun) >= 1")).toThrow(ExpressionError);
  });
});

describe("format safety properties", () => {
  const minimal = (verdictMap: string) => `
framework: test-fw
version: "1"
crosswalk_version: "0.0.1"
controls:
  - id: t-1
    title: Test
    requirement_summary: A test control.
    assertions:
      - id: t-1-a
        description: test
        source_class: observed
        capability: agent_lifecycle
        expression: "coverage(AgentRun, [run_id]) >= 0.99"
        verdict_map:
${verdictMap}
`;

  it("rejects a crosswalk where missing data could produce a pass", () => {
    const evil = minimal(
      "          pass: evidenced\n          fail: not_evidenced\n          no_data: evidenced",
    );
    expect(() => loadCrosswalkText(evil)).toThrow();
  });

  it("rejects observed assertions that do not name their capability", () => {
    const text = minimal(
      "          pass: evidenced\n          fail: not_evidenced\n          no_data: unevaluable",
    ).replace("        capability: agent_lifecycle\n", "");
    expect(() => loadCrosswalkText(text)).toThrow(CrosswalkError);
  });

  it("rejects duplicate control ids and bad expressions at load time", () => {
    const good = minimal(
      "          pass: evidenced\n          fail: not_evidenced\n          no_data: unevaluable",
    );
    expect(() => loadCrosswalkText(good)).not.toThrow();

    const badExpr = good.replace(
      "coverage(AgentRun, [run_id]) >= 0.99",
      "coverage(AgentRun, [run_id])",
    );
    expect(() => loadCrosswalkText(badExpr)).toThrow(CrosswalkError);
  });
});
