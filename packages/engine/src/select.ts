import type { Events, EventType, NormalizedBatch } from "@proofbook/schema";
import type { Arg, SelectorFilter } from "@proofbook/crosswalk";

/**
 * Selector resolution: turn `ModelCall[linked(AgentRun)]` into concrete
 * event records. Pure functions over the batch; no I/O, no clock.
 */

export interface EventRecord {
  trace_id: string;
  span_id: string;
  run_id: string;
  [key: string]: unknown;
}

const EVENT_ARRAYS: Record<EventType, keyof Events> = {
  AgentRun: "agent_runs",
  ModelCall: "model_calls",
  ToolCall: "tool_calls",
  Delegation: "delegations",
  HumanCheckpoint: "human_checkpoints",
  DataAccess: "data_access",
  PolicyEvent: "policy_events",
  Error: "errors",
};

/** The timestamp field per event type, for date ranges and sequencing. */
export const TIME_FIELD: Record<EventType, string> = {
  AgentRun: "started_at",
  ModelCall: "started_at",
  ToolCall: "started_at",
  Delegation: "at",
  HumanCheckpoint: "at",
  DataAccess: "at",
  PolicyEvent: "at",
  Error: "at",
};

export function valueAt(obj: unknown, path: string): unknown {
  let cursor: unknown = obj;
  for (const part of path.split(".")) {
    if (cursor === null || typeof cursor !== "object") return undefined;
    cursor = (cursor as Record<string, unknown>)[part];
  }
  return cursor;
}

export function eventsOf(batch: NormalizedBatch, eventType: string): EventRecord[] {
  const key = EVENT_ARRAYS[eventType as EventType];
  return (batch.events[key] ?? []) as unknown as EventRecord[];
}

function applyFilter(
  events: EventRecord[],
  filter: SelectorFilter,
  batch: NormalizedBatch,
): EventRecord[] {
  if (filter.kind === "linked") {
    const linkedRuns = new Set(eventsOf(batch, filter.eventType).map((e) => e.run_id));
    return events.filter((e) => linkedRuns.has(e.run_id));
  }
  // Raw filter: `path=value`. String equality, numeric when both sides parse.
  const m = filter.text.match(/^([\w.]+)\s*=\s*(.+)$/);
  if (!m) {
    throw new EngineError(`unsupported selector filter "${filter.text}"`);
  }
  const [, path, rawValue] = m;
  const numeric = Number(rawValue);
  return events.filter((e) => {
    const v = valueAt(e, path!);
    if (typeof v === "number" && Number.isFinite(numeric)) return v === numeric;
    return String(v) === rawValue;
  });
}

export class EngineError extends Error {}

export function resolveSelector(
  batch: NormalizedBatch,
  arg: Arg,
): { eventType: string; events: EventRecord[] } {
  if (arg.kind !== "selector") {
    throw new EngineError(`expected a selector argument, got ${arg.kind}`);
  }
  let events = eventsOf(batch, arg.eventType);
  if (arg.filter) events = applyFilter(events, arg.filter, batch);
  return { eventType: arg.eventType, events };
}
