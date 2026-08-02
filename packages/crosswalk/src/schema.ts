import { z } from "zod";
import { CAPABILITY_IDS, SourceClass } from "@proofbook/schema";

/**
 * Structural validation for crosswalk files. Mirrors the published
 * JSON Schema (crosswalk/schema/crosswalk.schema.json); zod is the
 * enforcement, the JSON Schema is the independently usable artifact.
 *
 * The verdict_map constraints below are the format's central safety
 * property: `no_data` maps to `unevaluable` and nothing else, so a
 * crosswalk author cannot write a control that passes on missing
 * telemetry, accidentally or otherwise.
 */

const id = z.string().regex(/^[a-z0-9.-]+$/);

export const VerdictMap = z.object({
  pass: z.literal("evidenced"),
  partial: z.literal("partially_evidenced").optional(),
  fail: z.enum(["not_evidenced", "contradicted"]),
  no_data: z.literal("unevaluable"),
});
export type VerdictMap = z.infer<typeof VerdictMap>;

export const EvidenceSpec = z.object({
  selector: z.string(),
  sample: z.number().int().positive().optional(),
  summarise: z
    .array(z.enum(["count", "date_range", "distinct_agents", "distinct_models", "distinct_tools", "rate"]))
    .optional(),
});
export type EvidenceSpec = z.infer<typeof EvidenceSpec>;

export const Assertion = z.object({
  id,
  description: z.string(),
  source_class: SourceClass,
  capability: z.enum(CAPABILITY_IDS).optional(),
  expression: z.string(),
  partial_expression: z.string().optional(),
  evidence: EvidenceSpec.optional(),
  verdict_map: VerdictMap,
});
export type Assertion = z.infer<typeof Assertion>;

export const Control = z.object({
  id,
  article: z.string().optional(),
  title: z.string(),
  /** Original paraphrase. Never the text of the standard. */
  requirement_summary: z.string(),
  assertions: z.array(Assertion).min(1),
});
export type Control = z.infer<typeof Control>;

export const CrosswalkFile = z.object({
  framework: z.string().regex(/^[a-z0-9-]+$/),
  version: z.string(),
  crosswalk_version: z.string().regex(/^\d+\.\d+\.\d+$/),
  controls: z.array(Control).min(1),
});
export type CrosswalkFile = z.infer<typeof CrosswalkFile>;

const FrameworkRef = z.union([
  z.array(id),
  z.object({ pending: z.array(z.string()).min(1) }),
]);

export const EquivalenceFile = z.object({
  crosswalk_version: z.string().regex(/^\d+\.\d+\.\d+$/),
  equivalences: z
    .array(
      z.object({
        evidence: z.string(),
        controls: z.record(FrameworkRef),
      }),
    )
    .min(1),
});
export type EquivalenceFile = z.infer<typeof EquivalenceFile>;
