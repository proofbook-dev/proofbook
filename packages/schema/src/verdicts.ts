import { z } from "zod";

/**
 * The verdict and source-class vocabulary. Shared by the crosswalk
 * (which declares them), the engine (which produces them) and the
 * report (which displays them). Nothing else may invent verdict states.
 */

export const VERDICTS = [
  "evidenced",
  "partially_evidenced",
  "not_evidenced",
  /** Evidence exists and actively contradicts the control. Worse than absent. */
  "contradicted",
  /** The telemetry cannot answer the question. Never a silent pass. */
  "unevaluable",
] as const;
export const Verdict = z.enum(VERDICTS);
export type Verdict = z.infer<typeof Verdict>;

/**
 * The single most differentiating field in the output: is this claim
 * demonstrated, checked, or asserted? Required on every assertion and
 * every verdict.
 */
export const SOURCE_CLASSES = ["observed", "configured", "declared"] as const;
export const SourceClass = z.enum(SOURCE_CLASSES);
export type SourceClass = z.infer<typeof SourceClass>;

/** Capability ids produced by the completeness scorer (stage 2). */
export const CAPABILITY_IDS = [
  "span_coverage",
  "agent_lifecycle",
  "model_identity",
  "token_accounting",
  "tool_invocation",
  "human_oversight",
  "content_integrity",
] as const;
export type CapabilityId = (typeof CAPABILITY_IDS)[number];
