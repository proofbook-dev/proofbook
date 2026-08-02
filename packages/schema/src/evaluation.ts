import { z } from "zod";
import { SourceClass, Verdict } from "./verdicts.js";

/**
 * Evaluation results. Produced by the engine, consumed by seal and
 * report. The derivation is not decoration: an auditor asking "how did
 * you conclude that" must get the events consulted, the intermediate
 * values and the threshold applied, without rerunning anything.
 */

export const EventRef = z.object({
  trace_id: z.string(),
  span_id: z.string(),
});
export type EventRef = z.infer<typeof EventRef>;

export const Derivation = z.object({
  expression: z.string(),
  /** The raw outcome before the verdict_map is applied. */
  outcome: z.enum(["pass", "partial", "fail", "no_data"]),
  comparator: z.object({ op: z.string(), value: z.number() }).optional(),
  /** Named intermediate values: populated, total, value, ... */
  intermediates: z.record(z.union([z.number(), z.string(), z.boolean()])),
  /** Per selector: how many events, and a deterministic metadata-only sample. */
  events_consulted: z.array(
    z.object({
      event_type: z.string(),
      total: z.number().int().nonnegative(),
      sample: z.array(EventRef),
    }),
  ),
});
export type Derivation = z.infer<typeof Derivation>;

export const EvidenceSummary = z.object({
  selector: z.string(),
  count: z.number().int().nonnegative(),
  date_range: z.tuple([z.string(), z.string()]).optional(),
  distinct_agents: z.array(z.string()).optional(),
  distinct_models: z.array(z.string()).optional(),
  distinct_tools: z.array(z.string()).optional(),
  rate: z.number().optional(),
  sample: z.array(EventRef),
});
export type EvidenceSummary = z.infer<typeof EvidenceSummary>;

export const AssertionResult = z.object({
  assertion_id: z.string(),
  description: z.string(),
  source_class: SourceClass,
  capability: z.string().optional(),
  verdict: Verdict,
  derivation: Derivation,
  evidence: EvidenceSummary.optional(),
  /** Required whenever the verdict is unevaluable: what exactly is missing. */
  unevaluable_reason: z.string().optional(),
});
export type AssertionResult = z.infer<typeof AssertionResult>;

export const ControlResult = z.object({
  control_id: z.string(),
  article: z.string().optional(),
  title: z.string(),
  requirement_summary: z.string(),
  verdict: Verdict,
  assertions: z.array(AssertionResult).min(1),
});
export type ControlResult = z.infer<typeof ControlResult>;

export const VerdictCounts = z.object({
  evidenced: z.number().int().nonnegative(),
  partially_evidenced: z.number().int().nonnegative(),
  not_evidenced: z.number().int().nonnegative(),
  contradicted: z.number().int().nonnegative(),
  unevaluable: z.number().int().nonnegative(),
});
export type VerdictCounts = z.infer<typeof VerdictCounts>;

export const FrameworkEvaluation = z.object({
  framework: z.string(),
  framework_version: z.string(),
  crosswalk_version: z.string(),
  /** Content hash of the exact crosswalk file that produced these verdicts. */
  crosswalk_pin: z.string(),
  event_schema_version: z.string(),
  summary: VerdictCounts,
  controls: z.array(ControlResult).min(1),
});
export type FrameworkEvaluation = z.infer<typeof FrameworkEvaluation>;
