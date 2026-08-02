import { describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { normalizeOtlpFiles } from "@proofbook/normalize";
import { loadCrosswalkDir } from "@proofbook/crosswalk";
import { evaluateFramework } from "@proofbook/engine";
import { renderReport, type ReportInput } from "../src/index.js";

const fixtures = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "fixtures", "traces");
const basic = join(fixtures, "otel-genai-basic.json");
const partial = join(fixtures, "otel-genai-partial.json");

async function reportInput(paths: string[]): Promise<ReportInput> {
  const batch = await normalizeOtlpFiles(paths);
  const frameworks = await loadCrosswalkDir();
  const evaluations = [evaluateFramework(batch, frameworks.get("eu-ai-act")!)];
  return { batch, evaluations, meta: { subject: "acme-claims/agent-runtime", tool_version: "0.1.0" } };
}

describe("the Agent Trust Report", () => {
  it("renders a self-contained document with the honest verdict mix", async () => {
    const html = renderReport(await reportInput([basic]));

    expect(html).toMatch(/^<!DOCTYPE html>/);
    expect(html).toContain("AGENT TRUST REPORT");
    // No external anything: self-contained is a hard requirement.
    expect(html).not.toMatch(/src\s*=\s*"http/);
    expect(html).not.toMatch(/href\s*=\s*"http/);
    expect(html).not.toContain("<script");

    // The honest mix from the engine, all present.
    expect(html).toContain("✓ Evidenced");
    expect(html).toContain("✕ Not evidenced");
    expect(html).toContain("─ Unevaluable");
    expect(html).toContain("Why unevaluable:");
    expect(html).toContain("signed declaration");
  });

  it("leads with the checklist and actions, in plain language", async () => {
    const html = renderReport(await reportInput([basic]));

    const glanceAt = html.indexOf("Where you stand");
    const checklistAt = html.indexOf("The checklist");
    const actionsAt = html.indexOf("What to do next");
    const detailAt = html.indexOf("The evidence, control by control");
    expect(glanceAt).toBeGreaterThan(-1);
    expect(glanceAt).toBeLessThan(checklistAt);
    expect(checklistAt).toBeLessThan(actionsAt);
    expect(actionsAt).toBeLessThan(detailAt);

    // Checklist rows speak human, and every open box has an action.
    expect(html).toContain("Ready to cite");
    expect(html).toContain("Needs your input");
    expect(html).toContain("Have a named owner sign the declaration");
    expect(html).toContain("Enable content capture on the emitter");
  });

  it("states data-quality limits up front and details them in the appendix", async () => {
    const html = renderReport(await reportInput([partial]));

    // The at-a-glance block admits the limits before any checklist row.
    const noteAt = html.indexOf("Honesty first");
    const checklistAt = html.indexOf("The checklist");
    expect(noteAt).toBeGreaterThan(-1);
    expect(noteAt).toBeLessThan(checklistAt);

    expect(html).toContain("Data quality");
    expect(html).toContain("no agent runs observed");
    expect(html).toContain("Spans this report could not use");
    expect(html).toContain("no mapping rule matched in any generation");
  });

  it("shows derivations with thresholds and consulted events", async () => {
    const html = renderReport(await reportInput([basic]));
    expect(html).toContain("ratio(ModelCall[linked(AgentRun)], ModelCall) &gt;= 0.99");
    expect(html).toContain("a1b2c3d4e5f60002");
    expect(html).toContain("crosswalk 0.1.0 · pinned sha256:");
  });

  it("never leaks content, and escapes whatever it is given", async () => {
    const input = await reportInput([basic]);
    const html = renderReport(input);
    expect(html).not.toContain("Triage this claim");
    expect(html).not.toContain("m.keane@acme.example");

    // Hostile strings in upstream data must render inert.
    input.meta.subject = `<script>alert(1)</script>`;
    const hostile = renderReport(input);
    expect(hostile).not.toContain("<script>alert(1)");
    expect(hostile).toContain("&lt;script&gt;");
  });

  it("is deterministic for a fixed generated_at", async () => {
    const input = await reportInput([basic]);
    input.meta.generated_at = "2026-08-02T12:00:00.000Z";
    expect(renderReport(input)).toEqual(renderReport(input));
  });
});

describe("the activity log", () => {
  it("shows every run with inspectable per-event detail, metadata only", async () => {
    const html = renderReport(await reportInput([basic]));

    expect(html).toContain("Activity log");
    expect(html).toContain("agent claims-triage");
    expect(html).toContain("delegates claims-triage → fraud-check");
    expect(html).toContain("tool lookup_policy @ policy-db · success");
    expect(html).toContain("human approval · approved");
    expect(html).toContain("error · RateLimitError");
    expect(html).toContain("1211→246 tok");
    // Still nothing but metadata.
    expect(html).not.toContain("Triage this claim");
  });

  it("labels runs that have no agent span, honestly", async () => {
    const html = renderReport(await reportInput([partial]));
    expect(html).toContain("no agent span");
    expect(html).toContain("token usage not emitted");
  });
});
