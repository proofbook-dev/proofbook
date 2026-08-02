import { z } from "zod";

/**
 * The internal event model.
 *
 * This schema is deliberately independent of OpenTelemetry. Telemetry
 * conventions churn; this model does not get to. Every bundle records
 * EVENT_SCHEMA_VERSION so a verifier knows exactly what it is reading.
 *
 * Two invariants, enforced here and relied on everywhere downstream:
 *
 * 1. No payload content, ever. Prompts, completions, tool arguments and
 *    results appear only as ContentRef (a digest plus an optional pointer
 *    to customer-controlled storage). The normaliser hashes content it
 *    encounters and drops the plaintext before events leave the function.
 *
 * 2. Every event carries source provenance (trace_id / span_id) so a
 *    control derivation can name the exact events it consulted. An
 *    auditor asking "how did you conclude that" gets an answer that
 *    terminates at specific telemetry records.
 */

export const EVENT_SCHEMA_VERSION = "0.1.0";

/** Digest of content that never enters the evidence path in plaintext. */
export const ContentRef = z.object({
  /** sha256 hex digest of the source content (unsalted at normalise time; sealing salts). */
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  /** Optional pointer to customer-controlled storage. Never dereferenced by Proofbook. */
  ptr: z.string().optional(),
});
export type ContentRef = z.infer<typeof ContentRef>;

/** Provenance every event carries back to its telemetry source. */
const sourceFields = {
  trace_id: z.string(),
  span_id: z.string(),
};

/** ISO 8601 UTC timestamp. */
const isoTime = z.string().datetime({ offset: false });

export const AgentRun = z.object({
  ...sourceFields,
  run_id: z.string(),
  agent_id: z.string(),
  agent_name: z.string().optional(),
  started_at: isoTime,
  ended_at: isoTime.optional(),
  initiator: z.string().optional(),
  session_id: z.string().optional(),
});
export type AgentRun = z.infer<typeof AgentRun>;

export const TokenUsage = z.object({
  input: z.number().int().nonnegative().optional(),
  output: z.number().int().nonnegative().optional(),
});
export type TokenUsage = z.infer<typeof TokenUsage>;

export const ModelCall = z.object({
  ...sourceFields,
  run_id: z.string(),
  /** The company whose API actually processed the request (post attribution correction). */
  provider: z.string(),
  model: z.string(),
  request_params: z
    .object({
      temperature: z.number().optional(),
      max_tokens: z.number().int().optional(),
      top_p: z.number().optional(),
    })
    .optional(),
  token_usage: TokenUsage.optional(),
  finish_reason: z.string().optional(),
  latency_ms: z.number().nonnegative().optional(),
  content_ref: z
    .object({
      prompt: ContentRef.optional(),
      completion: ContentRef.optional(),
    })
    .optional(),
  started_at: isoTime,
});
export type ModelCall = z.infer<typeof ModelCall>;

export const ToolCall = z.object({
  ...sourceFields,
  run_id: z.string(),
  tool_name: z.string(),
  /** MCP server identity, when the tool is served over MCP. */
  server: z.string().optional(),
  arguments_ref: ContentRef.optional(),
  result_ref: ContentRef.optional(),
  outcome: z.enum(["success", "error", "unknown"]),
  latency_ms: z.number().nonnegative().optional(),
  started_at: isoTime,
});
export type ToolCall = z.infer<typeof ToolCall>;

export const Delegation = z.object({
  ...sourceFields,
  run_id: z.string(),
  parent_agent: z.string(),
  child_agent: z.string(),
  reason_ref: ContentRef.optional(),
  at: isoTime,
});
export type Delegation = z.infer<typeof Delegation>;

export const HumanCheckpoint = z.object({
  ...sourceFields,
  run_id: z.string(),
  type: z.enum(["approval", "review", "override", "abort"]),
  /** Digest of the acting identity. Never the identity itself. */
  actor_ref: ContentRef.optional(),
  decision: z.string().optional(),
  at: isoTime,
});
export type HumanCheckpoint = z.infer<typeof HumanCheckpoint>;

export const DataAccess = z.object({
  ...sourceFields,
  run_id: z.string(),
  resource: z.string(),
  classification_hint: z.string().optional(),
  operation: z.enum(["read", "write", "delete"]),
  scope: z.string().optional(),
  at: isoTime,
});
export type DataAccess = z.infer<typeof DataAccess>;

export const PolicyEvent = z.object({
  ...sourceFields,
  run_id: z.string(),
  source: z.string(),
  decision: z.string(),
  rule_id: z.string().optional(),
  at: isoTime,
});
export type PolicyEvent = z.infer<typeof PolicyEvent>;

export const ErrorEvent = z.object({
  ...sourceFields,
  run_id: z.string(),
  error_type: z.string(),
  at: isoTime,
});
export type ErrorEvent = z.infer<typeof ErrorEvent>;

export const Events = z.object({
  agent_runs: z.array(AgentRun),
  model_calls: z.array(ModelCall),
  tool_calls: z.array(ToolCall),
  delegations: z.array(Delegation),
  human_checkpoints: z.array(HumanCheckpoint),
  data_access: z.array(DataAccess),
  policy_events: z.array(PolicyEvent),
  errors: z.array(ErrorEvent),
});
export type Events = z.infer<typeof Events>;

export const EVENT_TYPES = [
  "AgentRun",
  "ModelCall",
  "ToolCall",
  "Delegation",
  "HumanCheckpoint",
  "DataAccess",
  "PolicyEvent",
  "Error",
] as const;
export type EventType = (typeof EVENT_TYPES)[number];
