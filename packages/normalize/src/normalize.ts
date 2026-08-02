import { createHash } from "node:crypto";
import {
  AgentRun,
  ContentRef,
  Delegation,
  ErrorEvent,
  EVENT_SCHEMA_VERSION,
  Events,
  HumanCheckpoint,
  MissingField,
  ModelCall,
  NormalizedBatch,
  SpanGenerationConflict,
  ToolCall,
  UnmappedSpan,
} from "@proofbook/schema";
import { nanoToIso, type ParsedSpan } from "./otlp.js";
import { CONFIDENCE_FLOOR, detectGenerations } from "./detect.js";
import { extract, matches, type GenerationRules, type Mapping } from "./rules.js";
import { scoreCompleteness } from "./completeness.js";

export class NormalizeError extends Error {}

function sha256(value: unknown): ContentRef {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return { sha256: createHash("sha256").update(text, "utf8").digest("hex") };
}

function setPath(target: Record<string, unknown>, path: string, value: unknown): void {
  const parts = path.split(".");
  let cursor = target;
  for (const part of parts.slice(0, -1)) {
    cursor[part] = cursor[part] ?? {};
    cursor = cursor[part] as Record<string, unknown>;
  }
  cursor[parts.at(-1)!] = value;
}

const eventSchemas = {
  AgentRun,
  ModelCall,
  ToolCall,
  HumanCheckpoint,
} as const;

/** Where each mapping's content_refs land on the event object. */
const contentRefTargets: Record<string, Record<string, string>> = {
  ModelCall: { prompt: "content_ref.prompt", completion: "content_ref.completion" },
  ToolCall: { arguments: "arguments_ref", result: "result_ref" },
  HumanCheckpoint: { actor: "actor_ref" },
};

function latencyMs(span: ParsedSpan): number {
  return Number((span.endNano - span.startNano) / 1_000_000n);
}

/** Structural fields the rule set never has to spell out. */
function structuralFields(mapping: Mapping, span: ParsedSpan): Record<string, unknown> {
  const base = {
    trace_id: span.traceId,
    span_id: span.spanId,
    run_id: span.traceId,
  };
  switch (mapping.event) {
    case "AgentRun":
      return {
        ...base,
        started_at: nanoToIso(span.startNano),
        ...(span.endNano > 0n ? { ended_at: nanoToIso(span.endNano) } : {}),
      };
    case "ModelCall":
      return { ...base, started_at: nanoToIso(span.startNano), latency_ms: latencyMs(span) };
    case "ToolCall":
      return {
        ...base,
        started_at: nanoToIso(span.startNano),
        latency_ms: latencyMs(span),
        outcome:
          span.statusCode === "ERROR" ? "error" : span.statusCode === "OK" ? "success" : "unknown",
      };
    case "HumanCheckpoint":
      return { ...base, at: nanoToIso(span.startNano) };
  }
}

interface MappedResult {
  event?: Record<string, unknown>;
  missing: MissingField[];
  failure?: string;
}

function applyMapping(mapping: Mapping, span: ParsedSpan): MappedResult {
  const event = structuralFields(mapping, span);
  const missing: MissingField[] = [];

  for (const [path, ex] of Object.entries(mapping.fields)) {
    const value = extract(span, ex);
    if (value === undefined) {
      if (ex.required) {
        missing.push({ event_type: mapping.event, span_id: span.spanId, field: path });
        return { missing, failure: `missing required field: ${path}` };
      }
      if (ex.expected) {
        missing.push({ event_type: mapping.event, span_id: span.spanId, field: path });
      }
      continue;
    }
    setPath(event, path, value);
  }

  const refTargets = contentRefTargets[mapping.event] ?? {};
  for (const [refName, ex] of Object.entries(mapping.content_refs)) {
    const value = extract(span, ex);
    if (value === undefined) continue;
    const target = refTargets[refName];
    if (!target) continue;
    // Hash immediately; the plaintext goes no further than this frame.
    setPath(event, target, sha256(value));
  }

  const schema = eventSchemas[mapping.event];
  const parsed = schema.safeParse(event);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return {
      missing,
      failure: `invalid ${mapping.event}: ${issue?.path.join(".")} ${issue?.message}`,
    };
  }
  return { event: parsed.data as Record<string, unknown>, missing };
}

/**
 * Multi-agent traces: an invoke_agent span nested under another
 * invoke_agent span is a delegation. Derived after mapping because it is
 * a relationship between spans, not a property of one.
 */
function deriveDelegations(
  agentSpans: Map<string, { span: ParsedSpan; agentId: string }>,
  spansById: Map<string, ParsedSpan>,
): Delegation[] {
  const out: Delegation[] = [];
  for (const { span, agentId } of agentSpans.values()) {
    let parentId = span.parentSpanId;
    while (parentId) {
      const parentAgent = agentSpans.get(parentId);
      if (parentAgent) {
        out.push({
          trace_id: span.traceId,
          span_id: span.spanId,
          run_id: span.traceId,
          parent_agent: parentAgent.agentId,
          child_agent: agentId,
          at: nanoToIso(span.startNano),
        });
        break;
      }
      parentId = spansById.get(parentId)?.parentSpanId;
    }
  }
  return out;
}

function deriveErrors(spans: ParsedSpan[]): ErrorEvent[] {
  const out: ErrorEvent[] = [];
  for (const span of spans) {
    if (span.statusCode !== "ERROR") continue;
    const exception = span.events.find((e) => e.name === "exception");
    const errorType =
      (exception?.attrs["exception.type"] as string | undefined) ??
      (span.statusMessage !== undefined && span.statusMessage !== ""
        ? span.statusMessage
        : "error");
    out.push({
      trace_id: span.traceId,
      span_id: span.spanId,
      run_id: span.traceId,
      error_type: errorType,
      at: nanoToIso(span.endNano > 0n ? span.endNano : span.startNano),
    });
  }
  return out;
}

export interface NormalizeInput {
  spans: ParsedSpan[];
  rulesets: GenerationRules[];
  files: string[];
}

interface SpanResolution {
  mapping?: Mapping;
  generation?: string;
  result?: MappedResult;
  matchedGenerations: string[];
  failures: string[];
}

/**
 * Resolve one span against every generation's rules.
 *
 * A span carrying attributes from two generations matches both rule
 * sets. Resolution order is precedence (newest first); the first
 * generation whose mapping yields a valid event wins, and the multiple
 * match is recorded as a conflict rather than silently discarded. A
 * newer generation that matches but fails required fields falls back to
 * an older one, because a span that IS mappable must not become
 * unmappable by being ambiguous.
 */
function resolveSpan(span: ParsedSpan, rulesets: GenerationRules[]): SpanResolution {
  const candidates: Array<{ rules: GenerationRules; mapping: Mapping }> = [];
  for (const rules of rulesets) {
    const mapping = rules.mappings.find((m) => matches(span, m.match));
    if (mapping) candidates.push({ rules, mapping });
  }
  candidates.sort((a, b) => b.rules.precedence - a.rules.precedence);

  const matchedGenerations = candidates.map((c) => c.rules.generation);
  const failures: string[] = [];

  let newestAttempt: MappedResult | undefined;
  for (const { rules, mapping } of candidates) {
    const result = applyMapping(mapping, span);
    if (result.event) {
      return { mapping, generation: rules.generation, result, matchedGenerations, failures };
    }
    newestAttempt = newestAttempt ?? result;
    failures.push(`${rules.generation}: ${result.failure ?? "mapping failed"}`);
  }
  // Nothing produced a valid event; surface the newest generation's
  // missing-field records and failure so the gap is named, not vague.
  return newestAttempt
    ? { matchedGenerations, failures, result: newestAttempt }
    : { matchedGenerations, failures };
}

export function normalize({ spans, rulesets, files }: NormalizeInput): NormalizedBatch {
  const detections = detectGenerations(spans, rulesets);
  const best = detections[0];
  if (spans.length > 0 && (!best || best.confidence < CONFIDENCE_FLOOR)) {
    throw new NormalizeError(
      `cannot identify telemetry generation (best: ${
        best ? `"${best.generation}" at ${best.confidence}` : "none"
      }). Refusing to guess: evidence derived from misread telemetry is worse than no evidence.`,
    );
  }

  const events: Events = {
    agent_runs: [],
    model_calls: [],
    tool_calls: [],
    delegations: [],
    human_checkpoints: [],
    data_access: [],
    policy_events: [],
    errors: [],
  };
  const unmapped: UnmappedSpan[] = [];
  const missingFields: MissingField[] = [];
  const conflicts: SpanGenerationConflict[] = [];
  const agentSpans = new Map<string, { span: ParsedSpan; agentId: string }>();
  const spansById = new Map(spans.map((s) => [s.spanId, s]));
  let mappedCount = 0;

  for (const span of spans) {
    const resolution = resolveSpan(span, rulesets);

    if (resolution.matchedGenerations.length === 0) {
      unmapped.push({
        trace_id: span.traceId,
        span_id: span.spanId,
        name: span.name,
        reason: "no mapping rule matched in any generation",
      });
      continue;
    }

    if (
      resolution.matchedGenerations.length > 1 &&
      resolution.generation &&
      !resolution.mapping?.shared
    ) {
      conflicts.push({
        trace_id: span.traceId,
        span_id: span.spanId,
        matched: resolution.matchedGenerations,
        resolved_to: resolution.generation,
      });
    }

    if (resolution.result) missingFields.push(...resolution.result.missing);

    if (!resolution.result?.event) {
      unmapped.push({
        trace_id: span.traceId,
        span_id: span.spanId,
        name: span.name,
        reason: resolution.result?.failure ?? resolution.failures[0] ?? "mapping failed",
      });
      continue;
    }

    mappedCount += 1;
    const mapping = resolution.mapping!;
    switch (mapping.event) {
      case "AgentRun": {
        const run = resolution.result.event as unknown as AgentRun;
        events.agent_runs.push(run);
        agentSpans.set(span.spanId, { span, agentId: run.agent_id });
        break;
      }
      case "ModelCall":
        events.model_calls.push(resolution.result.event as unknown as ModelCall);
        break;
      case "ToolCall":
        events.tool_calls.push(resolution.result.event as unknown as ToolCall);
        break;
      case "HumanCheckpoint":
        events.human_checkpoints.push(resolution.result.event as unknown as HumanCheckpoint);
        break;
    }
  }

  events.delegations = deriveDelegations(agentSpans, spansById);
  events.errors = deriveErrors(spans);

  const batch: NormalizedBatch = {
    schema_version: EVENT_SCHEMA_VERSION,
    source: { format: "otlp-json", files: [...files].sort() },
    detections,
    counts: {
      spans_seen: spans.length,
      spans_mapped: mappedCount,
      spans_unmapped: unmapped.length,
    },
    events,
    unmapped,
    missing_fields: missingFields,
    conflicts,
    completeness: scoreCompleteness(events, spans.length, mappedCount),
  };
  return NormalizedBatch.parse(batch);
}
