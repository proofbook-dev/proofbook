import {
  AssertionResult,
  ControlResult,
  Derivation,
  EventRef,
  EvidenceSummary,
  FrameworkEvaluation,
  NormalizedBatch,
  Verdict,
  VerdictCounts,
} from "@proofbook/schema";
import {
  parseExpression,
  type Assertion,
  type Control,
  type LoadedCrosswalk,
  type ParsedExpression,
} from "@proofbook/crosswalk";
import {
  EngineError,
  eventsOf,
  resolveSelector,
  TIME_FIELD,
  valueAt,
  type EventRecord,
} from "./select.js";

/**
 * The assertion engine. Pure and deterministic: no I/O, no clock, no
 * randomness; same batch + same crosswalk = same result, byte for byte.
 *
 * The one correctness property everything defends: missing data can
 * never produce a pass. Absence flows to `no_data`, `no_data` flows to
 * `unevaluable` (the crosswalk format guarantees that mapping), and
 * every unevaluable verdict carries the reason.
 */

const SAMPLE_CAP = 20;

export interface EvaluateOptions {
  /** Signed declarations, keyed by declared(<key>). Absent until `attest` lands. */
  declarations?: Record<string, boolean>;
  /** Config-scan findings, keyed by config(<key>). Absent until `config-scan` lands. */
  config_checks?: Record<string, boolean>;
}

interface Consulted {
  event_type: string;
  total: number;
  sample: EventRef[];
}

type CallResult =
  | { kind: "numeric"; value: number; intermediates: Record<string, number>; consulted: Consulted[] }
  | { kind: "boolean"; value: boolean; intermediates: Record<string, number>; consulted: Consulted[] }
  | { kind: "no_data"; reason: string; consulted: Consulted[] };

function refs(events: EventRecord[]): EventRef[] {
  return events.slice(0, SAMPLE_CAP).map((e) => ({ trace_id: e.trace_id, span_id: e.span_id }));
}

function consulted(eventType: string, events: EventRecord[]): Consulted {
  return { event_type: eventType, total: events.length, sample: refs(events) };
}

function round(n: number): number {
  return Number(n.toFixed(4));
}

function populatedCount(events: EventRecord[], fields: string[]): number {
  return events.filter((e) => fields.every((f) => valueAt(e, f) !== undefined)).length;
}

function numericField(events: EventRecord[], field: string): number[] {
  return events
    .map((e) => valueAt(e, field))
    .filter((v): v is number => typeof v === "number" && Number.isFinite(v));
}

function evaluateCall(
  batch: NormalizedBatch,
  expr: ParsedExpression,
  options: EvaluateOptions,
): CallResult {
  const { fn, args } = expr;

  if (fn === "declared" || fn === "config") {
    const key = args[0]!.kind === "ident" ? (args[0] as { name: string }).name : "";
    const table = fn === "declared" ? options.declarations : options.config_checks;
    const value = table?.[key];
    if (value === undefined) {
      return {
        kind: "no_data",
        reason:
          fn === "declared"
            ? `requires a signed declaration for "${key}" (attest package); none provided`
            : `requires configuration verification for "${key}" (config-scan package); none provided`,
        consulted: [],
      };
    }
    return { kind: "boolean", value, intermediates: {}, consulted: [] };
  }

  const first = resolveSelector(batch, args[0]!);
  const noData = (reason: string, lists: Consulted[]): CallResult => ({
    kind: "no_data",
    reason,
    consulted: lists,
  });

  switch (fn) {
    case "coverage": {
      const fields = (args[1] as { fields: string[] }).fields;
      const total = first.events.length;
      if (total === 0) {
        return noData(`no ${first.eventType} events in the batch`, [consulted(first.eventType, [])]);
      }
      const populated = populatedCount(first.events, fields);
      return {
        kind: "numeric",
        value: round(populated / total),
        intermediates: { populated, total },
        consulted: [consulted(first.eventType, first.events)],
      };
    }
    case "count":
      return {
        kind: "numeric",
        value: first.events.length,
        intermediates: {},
        consulted: [consulted(first.eventType, first.events)],
      };
    case "ratio": {
      const second = resolveSelector(batch, args[1]!);
      const lists = [consulted(first.eventType, first.events), consulted(second.eventType, second.events)];
      if (second.events.length === 0) {
        return noData(`no ${second.eventType} events in the batch`, lists);
      }
      return {
        kind: "numeric",
        value: round(first.events.length / second.events.length),
        intermediates: { numerator: first.events.length, denominator: second.events.length },
        consulted: lists,
      };
    }
    case "distinct": {
      const field = (args[1] as { name: string }).name;
      if (first.events.length === 0) {
        return noData(`no ${first.eventType} events in the batch`, [consulted(first.eventType, [])]);
      }
      const values = new Set(
        first.events.map((e) => valueAt(e, field)).filter((v) => v !== undefined),
      );
      return {
        kind: "numeric",
        value: values.size,
        intermediates: { events: first.events.length },
        consulted: [consulted(first.eventType, first.events)],
      };
    }
    case "percentile": {
      const field = (args[1] as { name: string }).name;
      const p = (args[2] as { value: number }).value;
      const values = numericField(first.events, field).sort((a, b) => a - b);
      if (values.length === 0) {
        return noData(`no numeric ${first.eventType}.${field} values in the batch`, [
          consulted(first.eventType, first.events),
        ]);
      }
      const rank = Math.min(values.length - 1, Math.max(0, Math.ceil((p / 100) * values.length) - 1));
      return {
        kind: "numeric",
        value: round(values[rank]!),
        intermediates: { n: values.length, p },
        consulted: [consulted(first.eventType, first.events)],
      };
    }
    case "within": {
      const field = (args[1] as { name: string }).name;
      const limit = (args[2] as { value: number }).value;
      const values = numericField(first.events, field);
      if (values.length === 0) {
        return noData(`no numeric ${first.eventType}.${field} values in the batch`, [
          consulted(first.eventType, first.events),
        ]);
      }
      const inside = values.filter((v) => v <= limit).length;
      return {
        kind: "numeric",
        value: round(inside / values.length),
        intermediates: { inside, total: values.length, limit },
        consulted: [consulted(first.eventType, first.events)],
      };
    }
    case "exists":
      return {
        kind: "boolean",
        value: first.events.length > 0,
        intermediates: { count: first.events.length },
        consulted: [consulted(first.eventType, first.events)],
      };
    case "always": {
      const fields = (args[1] as { fields: string[] }).fields;
      if (first.events.length === 0) {
        return noData(`no ${first.eventType} events in the batch`, [consulted(first.eventType, [])]);
      }
      const populated = populatedCount(first.events, fields);
      return {
        kind: "boolean",
        value: populated === first.events.length,
        intermediates: { populated, total: first.events.length },
        consulted: [consulted(first.eventType, first.events)],
      };
    }
    case "never":
      // Matching zero events is the asserted state; instrumentation
      // absence is handled by the capability gate before we get here.
      return {
        kind: "boolean",
        value: first.events.length === 0,
        intermediates: { matched: first.events.length },
        consulted: [consulted(first.eventType, first.events)],
      };
    case "sequence": {
      // Every A event is preceded (same run) by at least one B event.
      const second = resolveSelector(batch, args[1]!);
      const lists = [consulted(first.eventType, first.events), consulted(second.eventType, second.events)];
      if (first.events.length === 0) {
        return noData(`no ${first.eventType} events in the batch`, lists);
      }
      const aTime = TIME_FIELD[first.eventType as keyof typeof TIME_FIELD];
      const bTime = TIME_FIELD[second.eventType as keyof typeof TIME_FIELD];
      const byRun = new Map<string, string[]>();
      for (const b of second.events) {
        const t = valueAt(b, bTime) as string | undefined;
        if (t === undefined) continue;
        const list = byRun.get(b.run_id) ?? [];
        list.push(t);
        byRun.set(b.run_id, list);
      }
      const satisfied = first.events.filter((a) => {
        const t = valueAt(a, aTime) as string | undefined;
        return t !== undefined && (byRun.get(a.run_id) ?? []).some((bt) => bt <= t);
      }).length;
      return {
        kind: "boolean",
        value: satisfied === first.events.length,
        intermediates: { satisfied, total: first.events.length },
        consulted: lists,
      };
    }
    default:
      throw new EngineError(`no evaluator for function "${fn}"`);
  }
}

function compare(op: string, value: number, threshold: number): boolean {
  switch (op) {
    case ">=": return value >= threshold;
    case "<=": return value <= threshold;
    case ">": return value > threshold;
    case "<": return value < threshold;
    case "==": return value === threshold;
    default: throw new EngineError(`unknown comparator "${op}"`);
  }
}

function distinctInRuns(
  batch: NormalizedBatch,
  runIds: Set<string>,
  eventType: string,
  field: string,
): string[] {
  const values = new Set<string>();
  for (const e of eventsOf(batch, eventType)) {
    if (!runIds.has(e.run_id)) continue;
    const v = valueAt(e, field);
    if (typeof v === "string") values.add(v);
  }
  return [...values].sort();
}

function buildEvidence(
  batch: NormalizedBatch,
  assertion: Assertion,
  mainValue: number | undefined,
): EvidenceSummary | undefined {
  const spec = assertion.evidence;
  if (!spec) return undefined;
  const events = eventsOf(batch, spec.selector);
  const cap = spec.sample ?? SAMPLE_CAP;
  const runIds = new Set(events.map((e) => e.run_id));
  const timeField = TIME_FIELD[spec.selector as keyof typeof TIME_FIELD];

  const summary: EvidenceSummary = {
    selector: spec.selector,
    count: events.length,
    sample: events.slice(0, cap).map((e) => ({ trace_id: e.trace_id, span_id: e.span_id })),
  };
  for (const kind of spec.summarise ?? []) {
    switch (kind) {
      case "count":
        break; // always present
      case "date_range": {
        const times = events
          .map((e) => valueAt(e, timeField))
          .filter((t): t is string => typeof t === "string")
          .sort();
        if (times.length > 0) summary.date_range = [times[0]!, times.at(-1)!];
        break;
      }
      case "distinct_agents":
        summary.distinct_agents = distinctInRuns(batch, runIds, "AgentRun", "agent_id");
        break;
      case "distinct_models":
        summary.distinct_models = distinctInRuns(batch, runIds, "ModelCall", "model");
        break;
      case "distinct_tools":
        summary.distinct_tools = distinctInRuns(batch, runIds, "ToolCall", "tool_name");
        break;
      case "rate":
        if (mainValue !== undefined) summary.rate = mainValue;
        break;
    }
  }
  return summary;
}

export function evaluateAssertion(
  batch: NormalizedBatch,
  assertion: Assertion,
  options: EvaluateOptions = {},
): AssertionResult {
  const expr = parseExpression(assertion.expression);

  let outcome: Derivation["outcome"];
  let reason: string | undefined;
  let call: CallResult;
  let mainValue: number | undefined;

  // Capability gate: if the completeness scorer says the telemetry
  // cannot support this category at all, the verdict is unevaluable
  // before any expression runs. Degraded capabilities still evaluate;
  // the numbers speak for themselves.
  const capability =
    assertion.capability !== undefined
      ? batch.completeness.capabilities.find((c) => c.id === assertion.capability)
      : undefined;

  if (capability && capability.status === "unavailable") {
    outcome = "no_data";
    reason = capability.reason ?? `capability ${capability.id} unavailable`;
    call = { kind: "no_data", reason, consulted: [] };
  } else {
    call = evaluateCall(batch, expr, options);
    if (call.kind === "no_data") {
      outcome = "no_data";
      reason = call.reason;
    } else if (call.kind === "boolean") {
      outcome = call.value ? "pass" : "fail";
    } else {
      mainValue = call.value;
      if (compare(expr.comparator!.op, call.value, expr.comparator!.value)) {
        outcome = "pass";
      } else if (assertion.partial_expression !== undefined) {
        const partialExpr = parseExpression(assertion.partial_expression);
        const partialCall = evaluateCall(batch, partialExpr, options);
        outcome =
          partialCall.kind === "numeric" &&
          compare(partialExpr.comparator!.op, partialCall.value, partialExpr.comparator!.value)
            ? "partial"
            : "fail";
      } else {
        outcome = "fail";
      }
    }
  }

  const verdictMap = assertion.verdict_map;
  const verdict: Verdict =
    outcome === "pass"
      ? verdictMap.pass
      : outcome === "partial"
        ? verdictMap.partial!
        : outcome === "fail"
          ? verdictMap.fail
          : verdictMap.no_data;

  const derivation: Derivation = {
    expression: assertion.expression,
    outcome,
    ...(expr.comparator ? { comparator: expr.comparator } : {}),
    intermediates: {
      ...(call.kind !== "no_data" ? call.intermediates : {}),
      ...(mainValue !== undefined ? { value: mainValue } : {}),
      ...(call.kind === "boolean" ? { result: call.value } : {}),
    },
    events_consulted: call.consulted,
  };

  const evidence = buildEvidence(batch, assertion, mainValue);

  return AssertionResult.parse({
    assertion_id: assertion.id,
    description: assertion.description,
    source_class: assertion.source_class,
    ...(assertion.capability !== undefined ? { capability: assertion.capability } : {}),
    verdict,
    derivation,
    ...(evidence ? { evidence } : {}),
    ...(verdict === "unevaluable" && reason !== undefined ? { unevaluable_reason: reason } : {}),
  });
}

/** Worst verdict wins. A control is only as good as its weakest assertion. */
const SEVERITY: Record<Verdict, number> = {
  evidenced: 0,
  partially_evidenced: 1,
  unevaluable: 2,
  not_evidenced: 3,
  contradicted: 4,
};

export function evaluateControl(
  batch: NormalizedBatch,
  control: Control,
  options: EvaluateOptions = {},
): ControlResult {
  const assertions = control.assertions.map((a) => evaluateAssertion(batch, a, options));
  const verdict = assertions
    .map((a) => a.verdict)
    .reduce((worst, v) => (SEVERITY[v] > SEVERITY[worst] ? v : worst));
  return ControlResult.parse({
    control_id: control.id,
    ...(control.article !== undefined ? { article: control.article } : {}),
    title: control.title,
    requirement_summary: control.requirement_summary,
    verdict,
    assertions,
  });
}

export function evaluateFramework(
  batch: NormalizedBatch,
  crosswalk: LoadedCrosswalk,
  options: EvaluateOptions = {},
): FrameworkEvaluation {
  const controls = crosswalk.doc.controls.map((c) => evaluateControl(batch, c, options));
  const summary: VerdictCounts = {
    evidenced: 0,
    partially_evidenced: 0,
    not_evidenced: 0,
    contradicted: 0,
    unevaluable: 0,
  };
  for (const control of controls) summary[control.verdict] += 1;

  return FrameworkEvaluation.parse({
    framework: crosswalk.doc.framework,
    framework_version: crosswalk.doc.version,
    crosswalk_version: crosswalk.doc.crosswalk_version,
    crosswalk_pin: crosswalk.pin,
    event_schema_version: batch.schema_version,
    summary,
    controls,
  });
}
