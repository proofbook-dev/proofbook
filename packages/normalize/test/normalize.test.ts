import { describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { NormalizedBatch } from "@proofbook/schema";
import {
  loadBundledGenerations,
  normalize,
  NormalizeError,
  normalizeOtlpFiles,
  parseOtlpJson,
} from "../src/index.js";

const fixtures = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "fixtures", "traces");
const basic = join(fixtures, "otel-genai-basic.json");
const partial = join(fixtures, "otel-genai-partial.json");
const legacy = join(fixtures, "otel-genai-legacy.json");
const mixed = join(fixtures, "otel-genai-mixed.json");

describe("normalise: otel-genai basic fixture", () => {
  it("maps a full agent trace to the internal event model (golden)", async () => {
    const batch = await normalizeOtlpFiles([basic]);
    expect(batch).toMatchSnapshot();
  });

  it("validates against the NormalizedBatch schema", async () => {
    const batch = await normalizeOtlpFiles([basic]);
    expect(() => NormalizedBatch.parse(batch)).not.toThrow();
  });

  it("maps counts, delegation and human checkpoint correctly", async () => {
    const batch = await normalizeOtlpFiles([basic]);
    expect(batch.counts).toEqual({ spans_seen: 6, spans_mapped: 6, spans_unmapped: 0 });
    expect(batch.events.agent_runs).toHaveLength(2);
    expect(batch.events.model_calls).toHaveLength(2);
    expect(batch.events.tool_calls).toHaveLength(1);
    expect(batch.events.human_checkpoints).toHaveLength(1);

    const delegation = batch.events.delegations[0];
    expect(delegation).toMatchObject({ parent_agent: "claims-triage", child_agent: "fraud-check" });

    const checkpoint = batch.events.human_checkpoints[0];
    expect(checkpoint).toMatchObject({ type: "approval", decision: "approved" });
    expect(checkpoint?.actor_ref?.sha256).toMatch(/^[0-9a-f]{64}$/);

    const failure = batch.events.errors[0];
    expect(failure).toMatchObject({ error_type: "RateLimitError" });
  });

  it("does not register generation conflicts for shared extension mappings", async () => {
    const batch = await normalizeOtlpFiles([basic]);
    expect(batch.conflicts).toHaveLength(0);
  });

  it("hashes content and never lets plaintext into the batch", async () => {
    const batch = await normalizeOtlpFiles([basic]);
    const serialized = JSON.stringify(batch);
    expect(serialized).not.toContain("Triage this claim");
    expect(serialized).not.toContain("adjuster pool");
    expect(serialized).not.toContain("P-88231");
    expect(serialized).not.toContain("m.keane@acme.example");
    expect(batch.events.model_calls[0]?.content_ref?.prompt?.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(batch.events.tool_calls[0]?.arguments_ref?.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("is deterministic: same input, identical output", async () => {
    const a = await normalizeOtlpFiles([basic]);
    const b = await normalizeOtlpFiles([basic]);
    expect(JSON.stringify(a)).toEqual(JSON.stringify(b));
  });
});

describe("normalise: legacy generation (OpenLLMetry-era flat attributes)", () => {
  it("maps agent, model and tool spans from traceloop/llm attributes (golden)", async () => {
    const batch = await normalizeOtlpFiles([legacy]);
    expect(batch).toMatchSnapshot();
  });

  it("resolves identity and token counts from the legacy attribute names", async () => {
    const batch = await normalizeOtlpFiles([legacy]);
    expect(batch.counts).toEqual({ spans_seen: 3, spans_mapped: 3, spans_unmapped: 0 });

    expect(batch.events.agent_runs[0]).toMatchObject({ agent_id: "support-bot" });

    const call = batch.events.model_calls[0];
    expect(call).toMatchObject({
      provider: "openai",
      model: "gpt-4o-2024-08-06",
      token_usage: { input: 742, output: 128 },
      finish_reason: "stop",
    });

    const tool = batch.events.tool_calls[0];
    expect(tool).toMatchObject({ tool_name: "order_lookup", outcome: "success" });
    expect(tool?.arguments_ref?.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("hashes the indexed flat message attributes into one prompt digest", async () => {
    const batch = await normalizeOtlpFiles([legacy]);
    expect(batch.events.model_calls[0]?.content_ref?.prompt?.sha256).toMatch(/^[0-9a-f]{64}$/);
    const serialized = JSON.stringify(batch);
    expect(serialized).not.toContain("refund for order");
    expect(serialized).not.toContain("support agent for Acme");
  });

  it("detects the legacy generation as the strongest fingerprint", async () => {
    const batch = await normalizeOtlpFiles([legacy]);
    expect(batch.detections[0]?.generation).toBe("otel-genai-legacy");
    expect(batch.detections.length).toBeGreaterThan(1);
  });
});

describe("normalise: mixed generations and the conflict resolver", () => {
  it("prefers the newest generation and records the conflict", async () => {
    const batch = await normalizeOtlpFiles([mixed]);

    expect(batch.conflicts).toHaveLength(1);
    expect(batch.conflicts[0]).toMatchObject({
      matched: ["otel-genai-latest", "otel-genai"],
      resolved_to: "otel-genai-latest",
    });

    // The winning generation's fields: provider from gen_ai.provider.name,
    // content digests from the structured message attributes.
    const modern = batch.events.model_calls.find((c) => c.provider === "anthropic");
    expect(modern?.content_ref?.prompt?.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("maps single-generation spans in the same batch without conflict", async () => {
    const batch = await normalizeOtlpFiles([mixed]);
    const legacyCall = batch.events.model_calls.find((c) => c.provider === "openai");
    expect(legacyCall).toMatchObject({
      model: "gpt-4o-mini",
      token_usage: { input: 150, output: 40 },
    });
    expect(batch.counts).toEqual({ spans_seen: 2, spans_mapped: 2, spans_unmapped: 0 });
  });
});

describe("completeness scorer", () => {
  const capability = (batch: NormalizedBatch, id: string) =>
    batch.completeness.capabilities.find((c) => c.id === id);

  it("reports available capabilities for the full fixture", async () => {
    const batch = await normalizeOtlpFiles([basic]);
    expect(capability(batch, "span_coverage")?.status).toBe("available");
    expect(capability(batch, "agent_lifecycle")?.status).toBe("available");
    expect(capability(batch, "token_accounting")?.status).toBe("available");
    expect(capability(batch, "human_oversight")?.status).toBe("available");
  });

  it("degrades honestly when only some model calls carry content digests", async () => {
    const batch = await normalizeOtlpFiles([basic]);
    const content = capability(batch, "content_integrity");
    expect(content?.status).toBe("degraded");
    expect(content?.reason).toContain("1 of 2");
  });

  it("marks capabilities unavailable with actionable reasons on the partial fixture", async () => {
    const batch = await normalizeOtlpFiles([partial]);

    expect(batch.completeness.mapped_ratio).toBe(0.5);
    expect(capability(batch, "span_coverage")?.status).toBe("degraded");

    const tokens = capability(batch, "token_accounting");
    expect(tokens?.status).toBe("unavailable");
    expect(tokens?.reason).toContain("count-based controls are unevaluable");

    const oversight = capability(batch, "human_oversight");
    expect(oversight?.status).toBe("unavailable");
    expect(oversight?.reason).toContain("proofbook.human_checkpoint");
  });

  it("reports per-field population rates", async () => {
    const batch = await normalizeOtlpFiles([partial]);
    const tokenField = batch.completeness.field_population.find(
      (f) => f.event_type === "ModelCall" && f.field === "token_usage.input",
    );
    expect(tokenField).toMatchObject({ populated: 0, total: 1, rate: 0 });
  });
});

describe("normalise: partial and broken telemetry", () => {
  it("reports unmapped spans and missing fields instead of degrading silently", async () => {
    const batch = await normalizeOtlpFiles([partial]);

    expect(batch.counts).toEqual({ spans_seen: 4, spans_mapped: 2, spans_unmapped: 2 });

    const reasons = batch.unmapped.map((u) => u.reason);
    expect(reasons).toContain("missing required field: provider");
    expect(reasons).toContain("no mapping rule matched in any generation");

    const missing = batch.missing_fields.map((m) => m.field);
    expect(missing).toContain("provider");
    expect(missing).toContain("token_usage.input");
    expect(missing).toContain("token_usage.output");
  });

  it("recovers tool identity from the span name and outcome from status", async () => {
    const batch = await normalizeOtlpFiles([partial]);
    const tool = batch.events.tool_calls[0];
    expect(tool).toMatchObject({ tool_name: "send_email", outcome: "error" });
    expect(batch.events.errors.map((e) => e.error_type)).toContain("SMTP timeout");
  });
});

describe("normalise: refusal and edge cases", () => {
  it("refuses telemetry it cannot identify rather than guessing", async () => {
    const rulesets = await loadBundledGenerations();
    const spans = parseOtlpJson({
      resourceSpans: [
        {
          resource: { attributes: [] },
          scopeSpans: [
            {
              scope: { name: "http" },
              spans: [
                {
                  traceId: "00000000000000000000000000000001",
                  spanId: "0000000000000001",
                  name: "GET /health",
                  startTimeUnixNano: "1783674000000000000",
                  endTimeUnixNano: "1783674000010000000",
                  attributes: [{ key: "http.request.method", value: { stringValue: "GET" } }],
                },
              ],
            },
          ],
        },
      ],
    });
    expect(() => normalize({ spans, rulesets, files: ["x.json"] })).toThrow(NormalizeError);
  });

  it("handles an empty batch without inventing a detection failure", async () => {
    const rulesets = await loadBundledGenerations();
    const batch = normalize({ spans: [], rulesets, files: [] });
    expect(batch.counts).toEqual({ spans_seen: 0, spans_mapped: 0, spans_unmapped: 0 });
    expect(batch.completeness.mapped_ratio).toBe(1);
  });
});

describe("normalise: JSONL input (collector file exporter format)", () => {
  it("accepts one ExportTraceServiceRequest per line", async () => {
    const { readFile, writeFile } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const doc = JSON.parse(await readFile(basic, "utf8"));
    const jsonl = [JSON.stringify(doc), JSON.stringify(doc)].join("\n") + "\n";
    const path = join(tmpdir(), "proofbook-test-traces.jsonl");
    await writeFile(path, jsonl);

    const batch = await normalizeOtlpFiles([path]);
    // Two copies of the same request: spans are simply concatenated.
    expect(batch.counts.spans_seen).toBe(12);
  });
});
