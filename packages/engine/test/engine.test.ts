import { describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { loadBundledGenerations, normalize, normalizeOtlpFiles } from "@proofbook/normalize";
import { loadCrosswalkDir, type Assertion } from "@proofbook/crosswalk";
import { evaluateAssertion, evaluateFramework } from "../src/index.js";

const fixtures = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "fixtures", "traces");
const basic = join(fixtures, "otel-genai-basic.json");
const partial = join(fixtures, "otel-genai-partial.json");

async function euCrosswalk() {
  const frameworks = await loadCrosswalkDir();
  return frameworks.get("eu-ai-act")!;
}

describe("evaluating the EU AI Act crosswalk over the basic fixture", () => {
  it("produces the expected verdict summary, honestly mixed", async () => {
    const batch = await normalizeOtlpFiles([basic]);
    const result = evaluateFramework(batch, await euCrosswalk());

    expect(result.summary).toEqual({
      evidenced: 7,
      partially_evidenced: 0,
      not_evidenced: 1,
      contradicted: 0,
      unevaluable: 5,
    });

    const byId = Object.fromEntries(result.controls.map((c) => [c.control_id, c]));
    expect(byId["eu-ai-act-a12-record"]!.verdict).toBe("evidenced");
    expect(byId["eu-ai-act-a12-attribution"]!.verdict).toBe("evidenced");
    // Only one of two model calls carries content digests: a real gap.
    expect(byId["eu-ai-act-a12-input"]!.verdict).toBe("not_evidenced");
    // Declared and configured source classes have no evidence source yet.
    expect(byId["eu-ai-act-a50-disclosure"]!.verdict).toBe("unevaluable");
    expect(byId["eu-ai-act-a50-marking"]!.verdict).toBe("unevaluable");
  });

  it("attaches a full derivation to every verdict", async () => {
    const batch = await normalizeOtlpFiles([basic]);
    const result = evaluateFramework(batch, await euCrosswalk());

    const attribution = result.controls
      .find((c) => c.control_id === "eu-ai-act-a12-attribution")!
      .assertions[0]!;

    expect(attribution.derivation).toMatchObject({
      expression: "ratio(ModelCall[linked(AgentRun)], ModelCall) >= 0.99",
      outcome: "pass",
      comparator: { op: ">=", value: 0.99 },
      intermediates: { numerator: 2, denominator: 2, value: 1 },
    });
    expect(attribution.derivation.events_consulted).toHaveLength(2);
    expect(attribution.derivation.events_consulted[0]!.sample[0]).toMatchObject({
      trace_id: expect.stringMatching(/^[0-9a-f]{32}$/),
      span_id: expect.stringMatching(/^[0-9a-f]{16}$/),
    });
  });

  it("summarises sampled evidence as metadata only", async () => {
    const batch = await normalizeOtlpFiles([basic]);
    const result = evaluateFramework(batch, await euCrosswalk());

    const lifecycle = result.controls
      .find((c) => c.control_id === "eu-ai-act-a12-record")!
      .assertions.find((a) => a.assertion_id === "a12-record-lifecycle")!;

    expect(lifecycle.evidence).toMatchObject({
      selector: "AgentRun",
      count: 2,
      date_range: ["2026-07-10T09:00:00.000Z", "2026-07-10T09:00:12.000Z"],
      distinct_agents: ["claims-triage", "fraud-check"],
    });
    // Metadata only: refs, never content.
    expect(JSON.stringify(lifecycle.evidence)).not.toContain("Triage");
  });

  it("records the crosswalk pin so verdicts trace to exact text", async () => {
    const batch = await normalizeOtlpFiles([basic]);
    const crosswalk = await euCrosswalk();
    const result = evaluateFramework(batch, crosswalk);
    expect(result.crosswalk_pin).toBe(crosswalk.pin);
    expect(result.event_schema_version).toBe(batch.schema_version);
  });

  it("is deterministic", async () => {
    const batch = await normalizeOtlpFiles([basic]);
    const crosswalk = await euCrosswalk();
    const a = evaluateFramework(batch, crosswalk);
    const b = evaluateFramework(batch, crosswalk);
    expect(JSON.stringify(a)).toEqual(JSON.stringify(b));
  });
});

describe("no false pass, ever", () => {
  it("evaluates an empty batch to zero evidenced controls", async () => {
    const rulesets = await loadBundledGenerations();
    const batch = normalize({ spans: [], rulesets, files: [] });
    const result = evaluateFramework(batch, await euCrosswalk());

    expect(result.summary.evidenced).toBe(0);
    expect(result.summary.not_evidenced).toBe(0);
    expect(result.summary.contradicted).toBe(0);
    expect(result.summary.unevaluable).toBe(13);
    for (const control of result.controls) {
      for (const assertion of control.assertions) {
        expect(assertion.verdict).toBe("unevaluable");
        expect(assertion.unevaluable_reason).toBeTruthy();
      }
    }
  });

  it("marks controls unevaluable, with the capability's reason, when instrumentation is absent", async () => {
    const batch = await normalizeOtlpFiles([partial]);
    const result = evaluateFramework(batch, await euCrosswalk());

    const lifecycle = result.controls.find((c) => c.control_id === "eu-ai-act-a12-record")!;
    const assertion = lifecycle.assertions.find((a) => a.assertion_id === "a12-record-lifecycle")!;
    expect(assertion.verdict).toBe("unevaluable");
    expect(assertion.unevaluable_reason).toContain("no agent runs observed");

    // But what CAN be evaluated, is: the one model call identifies itself.
    const identity = lifecycle.assertions.find((a) => a.assertion_id === "a12-record-model-identity")!;
    expect(identity.verdict).toBe("evidenced");
  });

  it("produces contradicted when observed behaviour undermines the control", async () => {
    // basic (attributable runs) + partial (a model call belonging to no
    // agent run): attribution drops to 2/3 and the evidence now argues
    // against the control rather than being merely absent.
    const batch = await normalizeOtlpFiles([basic, partial]);
    const result = evaluateFramework(batch, await euCrosswalk());

    const attribution = result.controls.find(
      (c) => c.control_id === "eu-ai-act-a12-attribution",
    )!;
    expect(attribution.verdict).toBe("contradicted");
    expect(attribution.assertions[0]!.derivation.intermediates).toMatchObject({
      numerator: 2,
      denominator: 3,
      value: 0.6667,
    });
  });
});

describe("declared and configured source classes", () => {
  it("stays unevaluable without an evidence source, with a reason naming the missing package", async () => {
    const batch = await normalizeOtlpFiles([basic]);
    const result = evaluateFramework(batch, await euCrosswalk());
    const disclosure = result.controls
      .find((c) => c.control_id === "eu-ai-act-a50-disclosure")!
      .assertions[0]!;
    expect(disclosure.verdict).toBe("unevaluable");
    expect(disclosure.unevaluable_reason).toContain("signed declaration");
    expect(disclosure.unevaluable_reason).toContain("ai_interaction_disclosure");
  });

  it("evaluates when a declaration is provided", async () => {
    const batch = await normalizeOtlpFiles([basic]);
    const result = evaluateFramework(batch, await euCrosswalk(), {
      declarations: { ai_interaction_disclosure: true },
      config_checks: { synthetic_content_marking: false },
    });
    const byId = Object.fromEntries(result.controls.map((c) => [c.control_id, c]));
    expect(byId["eu-ai-act-a50-disclosure"]!.verdict).toBe("evidenced");
    expect(byId["eu-ai-act-a50-marking"]!.verdict).toBe("not_evidenced");
  });
});

describe("primitives beyond the shipped crosswalk", () => {
  const assertion = (expression: string, extra: Partial<Assertion> = {}): Assertion => ({
    id: "t-a",
    description: "test",
    source_class: "observed",
    capability: "span_coverage",
    expression,
    verdict_map: { pass: "evidenced", fail: "not_evidenced", no_data: "unevaluable" },
    ...extra,
  });

  it("sequence(): checkpoint preceded by tool call in the same run", async () => {
    const batch = await normalizeOtlpFiles([basic]);

    const preceded = evaluateAssertion(batch, assertion("sequence(HumanCheckpoint, ToolCall)"));
    expect(preceded.verdict).toBe("evidenced");
    expect(preceded.derivation.intermediates).toMatchObject({ satisfied: 1, total: 1 });

    // The reverse ordering does not hold: the tool call at 09:00:04 has
    // no checkpoint before it.
    const reversed = evaluateAssertion(batch, assertion("sequence(ToolCall, HumanCheckpoint)"));
    expect(reversed.verdict).toBe("not_evidenced");
  });

  it("within(), percentile(), distinct() and raw filters", async () => {
    const batch = await normalizeOtlpFiles([basic]);

    expect(
      evaluateAssertion(batch, assertion("within(ModelCall, latency_ms, 5000) >= 1")).verdict,
    ).toBe("evidenced");
    expect(
      evaluateAssertion(batch, assertion("percentile(ModelCall, latency_ms, 50) <= 2200")).verdict,
    ).toBe("evidenced");
    expect(
      evaluateAssertion(batch, assertion("distinct(AgentRun, agent_id) >= 2")).verdict,
    ).toBe("evidenced");
    expect(
      evaluateAssertion(batch, assertion("count(ToolCall[outcome=error]) <= 0")).verdict,
    ).toBe("evidenced");
    expect(
      evaluateAssertion(batch, assertion("never(ToolCall[outcome=error])")).verdict,
    ).toBe("evidenced");
  });
});
