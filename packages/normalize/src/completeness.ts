import type {
  Capability,
  CompletenessReport,
  Events,
  FieldPopulation,
} from "@proofbook/schema";

/**
 * The completeness scorer.
 *
 * Answers, honestly and up front: given what this batch could and could
 * not populate, what categories of evidence can it support? Capabilities
 * are the stage-2 proxy for control evaluability; when the crosswalk
 * lands, an `unevaluable` verdict points back at exactly one of these
 * rather than at a vague "insufficient data".
 *
 * Thresholds: a capability is `available` at >= 0.99 population,
 * `degraded` below that, `unavailable` at zero events or zero
 * population. 0.99 rather than 1.0 because production telemetry drops
 * spans at the margins and a single lost span must not flip a whole
 * category; anything below 0.99 is a real gap and says so.
 */

const AVAILABLE_THRESHOLD = 0.99;

/** Fields whose population rate is worth reporting, per event type. */
const SCORED_FIELDS: Record<string, string[]> = {
  AgentRun: ["agent_id", "ended_at", "session_id"],
  ModelCall: [
    "provider",
    "model",
    "token_usage.input",
    "token_usage.output",
    "finish_reason",
    "content_ref.prompt",
    "content_ref.completion",
  ],
  ToolCall: ["tool_name", "server", "arguments_ref", "result_ref"],
  HumanCheckpoint: ["type", "decision", "actor_ref"],
};

const EVENT_ARRAYS: Record<string, keyof Events> = {
  AgentRun: "agent_runs",
  ModelCall: "model_calls",
  ToolCall: "tool_calls",
  HumanCheckpoint: "human_checkpoints",
};

function valueAt(obj: unknown, path: string): unknown {
  let cursor: unknown = obj;
  for (const part of path.split(".")) {
    if (cursor === null || typeof cursor !== "object") return undefined;
    cursor = (cursor as Record<string, unknown>)[part];
  }
  return cursor;
}

function rate(populated: number, total: number): number {
  return total === 0 ? 0 : Number((populated / total).toFixed(4));
}

function scoreFields(events: Events): FieldPopulation[] {
  const out: FieldPopulation[] = [];
  for (const [eventType, fields] of Object.entries(SCORED_FIELDS)) {
    const list = events[EVENT_ARRAYS[eventType]!] as unknown[];
    for (const field of fields) {
      const populated = list.filter((e) => valueAt(e, field) !== undefined).length;
      out.push({
        event_type: eventType,
        field,
        populated,
        total: list.length,
        rate: rate(populated, list.length),
      });
    }
  }
  return out;
}

function statusFor(
  populated: number,
  total: number,
  unavailableReason: string,
  degradedReason: string,
): Pick<Capability, "status" | "reason"> {
  if (total === 0 || populated === 0) {
    return { status: "unavailable", reason: unavailableReason };
  }
  const r = populated / total;
  if (r >= AVAILABLE_THRESHOLD) return { status: "available" };
  return {
    status: "degraded",
    reason: `${degradedReason} (${populated} of ${total})`,
  };
}

function capabilities(events: Events, mappedRatio: number): Capability[] {
  const pop = (eventType: string, field: string) => {
    const list = events[EVENT_ARRAYS[eventType]!] as unknown[];
    return {
      populated: list.filter((e) => valueAt(e, field) !== undefined).length,
      total: list.length,
    };
  };

  const lifecycle = pop("AgentRun", "ended_at");
  const tokensIn = pop("ModelCall", "token_usage.input");
  const tokensOut = pop("ModelCall", "token_usage.output");
  const prompts = pop("ModelCall", "content_ref.prompt");
  const completions = pop("ModelCall", "content_ref.completion");

  const spanCoverage: Pick<Capability, "status" | "reason"> =
    mappedRatio >= AVAILABLE_THRESHOLD
      ? { status: "available" }
      : mappedRatio > 0
        ? {
            status: "degraded",
            reason: `${(mappedRatio * 100).toFixed(1)}% of spans mapped; the rest are enumerated as unmapped`,
          }
        : { status: "unavailable", reason: "no spans could be mapped" };

  const out: Capability[] = [
    {
      id: "span_coverage",
      description: "Spans in the batch map onto the internal event model",
      ...spanCoverage,
    },
    {
      id: "agent_lifecycle",
      description: "Agent runs carry a complete start/end lifecycle record",
      ...statusFor(
        lifecycle.populated,
        lifecycle.total,
        "no agent runs observed; agent lifecycle controls are unevaluable",
        "some agent runs are missing an end time",
      ),
    },
    {
      id: "model_identity",
      description: "Model calls identify the model and the processing provider",
      ...statusFor(
        pop("ModelCall", "model").populated,
        pop("ModelCall", "model").total,
        "no model calls observed",
        "some model calls are missing identity fields",
      ),
    },
    {
      id: "token_accounting",
      description: "Model calls carry input and output token counts",
      ...statusFor(
        Math.min(tokensIn.populated, tokensOut.populated),
        tokensIn.total,
        "no model calls carry token usage; count-based controls are unevaluable",
        "some model calls are missing token counts",
      ),
    },
    {
      id: "tool_invocation",
      description: "Tool invocations are recorded with identity and outcome",
      ...statusFor(
        pop("ToolCall", "tool_name").populated,
        pop("ToolCall", "tool_name").total,
        "no tool invocations observed",
        "some tool calls are missing identity",
      ),
    },
    {
      id: "human_oversight",
      description: "Human checkpoints (approval, review, override) are recorded",
      ...statusFor(
        pop("HumanCheckpoint", "type").populated,
        pop("HumanCheckpoint", "type").total,
        "no human checkpoint events; emit proofbook.human_checkpoint.* attributes " +
          "(or the LangGraph/Temporal integrations) or these controls stay unevaluable",
        "some checkpoints are incomplete",
      ),
    },
    {
      id: "content_integrity",
      description: "Prompt and completion content is digest-referenced",
      ...statusFor(
        Math.min(prompts.populated, completions.populated),
        prompts.total,
        "no content digests present; content-integrity controls are unevaluable",
        "some model calls are missing content digests",
      ),
    },
  ];
  return out;
}

export function scoreCompleteness(
  events: Events,
  spansSeen: number,
  spansMapped: number,
): CompletenessReport {
  const mappedRatio = spansSeen === 0 ? 1 : Number((spansMapped / spansSeen).toFixed(4));
  return {
    mapped_ratio: mappedRatio,
    field_population: scoreFields(events),
    capabilities: capabilities(events, mappedRatio),
  };
}
