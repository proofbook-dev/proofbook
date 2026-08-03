import type { NormalizedBatch } from "@proofbook/schema";
import type { LoadedCrosswalk } from "@proofbook/crosswalk";
import type { Log } from "./log.js";

/**
 * The cold-start transcript. The person reading this is a strong
 * engineer at 11pm with a stuck deal and ninety seconds of patience:
 * every line must prove the tool understands her stack, state what is
 * missing before showing verdicts so the verdicts read correctly, and
 * end by converting the biggest gap into a named engineering task.
 */

const CAPABILITY_LABEL: Record<string, string> = {
  span_coverage: "Span mapping",
  agent_lifecycle: "Agent runs",
  model_identity: "Model calls",
  token_accounting: "Token counts",
  tool_invocation: "Tool calls",
  human_oversight: "Human checkpoints",
  content_integrity: "Content digests",
};

/** capability id → CLI-friendly topic for `proof explain`. */
export const CAPABILITY_TOPIC: Record<string, string> = {
  span_coverage: "span-coverage",
  agent_lifecycle: "agent-lifecycle",
  model_identity: "model-identity",
  token_accounting: "token-counts",
  tool_invocation: "tool-calls",
  human_oversight: "human-checkpoints",
  content_integrity: "content-digests",
};

function timeRange(batch: NormalizedBatch): string | null {
  let min: string | null = null;
  let max: string | null = null;
  const consider = (t: unknown) => {
    if (typeof t !== "string") return;
    if (!min || t < min) min = t;
    if (!max || t > max) max = t;
  };
  const ev = batch.events as unknown as Record<string, Array<Record<string, unknown>>>;
  for (const list of Object.values(ev)) {
    for (const e of list) consider(e.started_at ?? e.at);
  }
  return min && max ? `${(min as string).slice(0, 10)} to ${(max as string).slice(0, 10)}` : null;
}

export function discoveryBlock(batch: NormalizedBatch, fileCount: number, log: Log): void {
  const range = timeRange(batch);
  log(
    `Found ${batch.counts.spans_seen.toLocaleString("en-US")} spans` +
      ` (${fileCount} file${fileCount === 1 ? "" : "s"}${range ? `, ${range}` : ""})`,
  );
  const detections = (batch as unknown as { detections?: { generation: string; confidence: number }[] })
    .detections ?? [];
  if (detections.length > 0) {
    const named = detections
      .filter((d) => d.confidence >= 0.2)
      .map((d) => d.generation)
      .join(", ");
    if (named) log(`Detected: OpenTelemetry GenAI conventions (${named})`);
  }
  log("");
}

export interface CapabilityImpact {
  capability: string;
  status: string;
  reason?: string | undefined;
  affected: number;
}

/** Controls whose observed assertions depend on each capability. */
export function capabilityImpacts(
  batch: NormalizedBatch,
  crosswalks: LoadedCrosswalk[],
): CapabilityImpact[] {
  const dependents = new Map<string, Set<string>>();
  for (const cw of crosswalks) {
    for (const control of cw.doc.controls) {
      for (const a of control.assertions) {
        if (a.source_class !== "observed" || !a.capability) continue;
        (dependents.get(a.capability) ?? dependents.set(a.capability, new Set()).get(a.capability)!)
          .add(control.id);
      }
    }
  }
  const caps = (batch.completeness as unknown as {
    capabilities: { id: string; status: string; reason?: string }[];
  }).capabilities;
  return caps.map((c) => ({
    capability: c.id,
    status: c.status,
    reason: c.reason,
    affected: dependents.get(c.id)?.size ?? 0,
  }));
}

export function coverageBlock(impacts: CapabilityImpact[], log: Log): void {
  log("Coverage check:");
  for (const i of impacts) {
    const label = (CAPABILITY_LABEL[i.capability] ?? i.capability).padEnd(19);
    if (i.status === "available") {
      log(`  ✓ ${label} complete`);
    } else {
      const glyph = i.status === "missing" ? "✗" : "⚠";
      log(`  ${glyph} ${label} ${i.reason ?? i.status}`);
      if (i.affected > 0) {
        log(
          `    ${"".padEnd(19)} → ${i.affected} control${i.affected === 1 ? "" : "s"} ` +
            `${i.status === "missing" ? "will be unevaluable" : "degraded"}`,
        );
      }
    }
  }
  log("");
}

/** The closing move: the biggest gap as a named engineering task. */
export function gapParagraph(impacts: CapabilityImpact[], log: Log): void {
  const missing = impacts
    .filter((i) => i.status === "missing" && i.affected > 0)
    .sort((a, b) => b.affected - a.affected)[0];
  if (!missing) return;
  const label = (CAPABILITY_LABEL[missing.capability] ?? missing.capability).toLowerCase();
  log("");
  log(
    `${missing.affected} control${missing.affected === 1 ? " is" : "s are"} unevaluable because ` +
      `no ${label.replace(/s$/, "")} events were found.`,
  );
  if (missing.capability === "human_oversight") {
    log("If your system does have approval gates, they are not instrumented.");
  } else {
    log("If your system does produce this, it is not reaching the telemetry.");
  }
  log(`See: proof explain ${CAPABILITY_TOPIC[missing.capability] ?? missing.capability}`);
}
