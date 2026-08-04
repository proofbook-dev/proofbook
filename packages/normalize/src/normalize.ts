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
  agentSpans: Map<
    string,
    { traceId: string; spanId: string; parentSpanId: string | undefined; startNano: bigint; agentId: string }
  >,
  parentById: Map<string, string | undefined>,
): Delegation[] {
  const out: Delegation[] = [];
  for (const entry of agentSpans.values()) {
    let parentId = entry.parentSpanId;
    while (parentId) {
      const parentAgent = agentSpans.get(parentId);
      if (parentAgent) {
        out.push({
          trace_id: entry.traceId,
          span_id: entry.spanId,
          run_id: entry.traceId,
          parent_agent: parentAgent.agentId,
          child_agent: entry.agentId,
          at: nanoToIso(entry.startNano),
        });
        break;
      }
      parentId = parentById.get(parentId);
    }
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

/** Detail lists are samples past this size; the counts stay exact. */
const DETAIL_SAMPLE_MAX = 500;
/** Generation fingerprinting saturates long before this many spans. */
const DETECTION_SAMPLE_MAX = 50_000;

export function normalize({ spans, rulesets, files }: NormalizeInput): NormalizedBatch {
  const machine = createNormalizer(rulesets, files);
  for (const span of spans) machine.add(span);
  return machine.finish();
}

/**
 * The streaming normalizer: spans go in one at a time and are released
 * immediately; only events, counters and a slim parent map stay. This
 * is what lets an 8 GB month normalise in a few hundred MB of heap.
 * Generation detection runs on the first DETECTION_SAMPLE_MAX spans
 * (fingerprints saturate long before that) and gates finish(), not
 * add(): a stream that turns out unreadable still refuses to guess.
 */
export function createNormalizer(rulesets: GenerationRules[], files: string[]) {
  const detectionSample: ParsedSpan[] = [];

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
  let unmappedCount = 0;
  let missingFieldCount = 0;
  let conflictCount = 0;
  const agentSpans = new Map<
    string,
    { traceId: string; spanId: string; parentSpanId: string | undefined; startNano: bigint; agentId: string }
  >();
  // Parent chain only: holding every full span for delegation lookups
  // is what runs multi-million-span batches out of memory.
  const parentById = new Map<string, string | undefined>();
  let mappedCount = 0;
  let spanCount = 0;

  function add(span: ParsedSpan): void {
    spanCount += 1;
    if (detectionSample.length < DETECTION_SAMPLE_MAX) detectionSample.push(span);
    parentById.set(span.spanId, span.parentSpanId);

    // Errors, derived inline so the span can be released right after.
    if (span.statusCode === "ERROR") {
      const exception = span.events.find((e) => e.name === "exception");
      const errorType =
        (exception?.attrs["exception.type"] as string | undefined) ??
        (span.statusMessage !== undefined && span.statusMessage !== ""
          ? span.statusMessage
          : "error");
      events.errors.push({
        trace_id: span.traceId,
        span_id: span.spanId,
        run_id: span.traceId,
        error_type: errorType,
        at: nanoToIso(span.endNano > 0n ? span.endNano : span.startNano),
      });
    }

    const resolution = resolveSpan(span, rulesets);

    if (resolution.matchedGenerations.length === 0) {
      unmappedCount += 1;
      if (unmapped.length < DETAIL_SAMPLE_MAX) {
        unmapped.push({
          trace_id: span.traceId,
          span_id: span.spanId,
          name: span.name,
          reason: "no mapping rule matched in any generation",
        });
      }
      return;
    }

    if (
      resolution.matchedGenerations.length > 1 &&
      resolution.generation &&
      !resolution.mapping?.shared
    ) {
      conflictCount += 1;
      if (conflicts.length < DETAIL_SAMPLE_MAX) {
        conflicts.push({
          trace_id: span.traceId,
          span_id: span.spanId,
          matched: resolution.matchedGenerations,
          resolved_to: resolution.generation,
        });
      }
    }

    if (resolution.result) {
      missingFieldCount += resolution.result.missing.length;
      for (const field of resolution.result.missing) {
        if (missingFields.length >= DETAIL_SAMPLE_MAX) break;
        missingFields.push(field);
      }
    }

    if (!resolution.result?.event) {
      unmappedCount += 1;
      if (unmapped.length < DETAIL_SAMPLE_MAX) {
        unmapped.push({
          trace_id: span.traceId,
          span_id: span.spanId,
          name: span.name,
          reason: resolution.result?.failure ?? resolution.failures[0] ?? "mapping failed",
        });
      }
      return;
    }

    mappedCount += 1;
    const mapping = resolution.mapping!;
    switch (mapping.event) {
      case "AgentRun": {
        const run = resolution.result.event as unknown as AgentRun;
        events.agent_runs.push(run);
        agentSpans.set(span.spanId, {
          traceId: span.traceId,
          spanId: span.spanId,
          parentSpanId: span.parentSpanId,
          startNano: span.startNano,
          agentId: run.agent_id,
        });
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

  function finish(): NormalizedBatch {
    const detections = detectGenerations(detectionSample, rulesets);
    const best = detections[0];
    if (spanCount > 0 && (!best || best.confidence < CONFIDENCE_FLOOR)) {
      throw new NormalizeError(
        `cannot identify telemetry generation (best: ${
          best ? `"${best.generation}" at ${best.confidence}` : "none"
        }). Refusing to guess: evidence derived from misread telemetry is worse than no evidence.`,
      );
    }

    events.delegations = deriveDelegations(agentSpans, parentById);
    // Chronological, deterministic order regardless of file order.
    for (const list of Object.values(events) as Array<Array<Record<string, unknown>>>) {
      list.sort((a, b) => {
        const ta = (a.started_at ?? a.at) as string;
        const tb = (b.started_at ?? b.at) as string;
        return ta < tb ? -1 : ta > tb ? 1 : (a.span_id as string) < (b.span_id as string) ? -1 : 1;
      });
    }

  const batch: NormalizedBatch = {
    schema_version: EVENT_SCHEMA_VERSION,
    source: { format: "otlp-json", files: [...files].sort() },
    detections,
    counts: {
      spans_seen: spanCount,
      spans_mapped: mappedCount,
      spans_unmapped: unmappedCount,
    },
    events,
    unmapped,
    missing_fields: missingFields,
    conflicts,
    completeness: scoreCompleteness(events, spanCount, mappedCount),
  };
    return NormalizedBatch.parse(batch);
  }

  return { add, finish };
}
