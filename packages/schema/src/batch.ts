import { z } from "zod";
import { Events, EVENT_SCHEMA_VERSION } from "./events.js";

/**
 * The output of normalisation: everything downstream (engine, seal,
 * report) consumes this and nothing else. It records not just the events
 * but what could NOT be mapped and which fields could not be populated,
 * because "we don't know" must flow through to `unevaluable` verdicts
 * rather than silently vanishing.
 */

export const GenerationDetection = z.object({
  /** e.g. "otel-genai" - the conventions generation the rules were written for. */
  generation: z.string(),
  /** 0..1. If no generation clears the confidence floor the normaliser refuses. */
  confidence: z.number().min(0).max(1),
  /** Signals that fired during fingerprinting, for the completeness report. */
  signals: z.array(z.string()),
});
export type GenerationDetection = z.infer<typeof GenerationDetection>;

/**
 * A span whose attributes matched mapping rules from more than one
 * conventions generation. Resolution prefers the newest generation that
 * yields a valid event; the discrepancy is recorded here and travels
 * into bundle metadata, never silently discarded.
 */
export const SpanGenerationConflict = z.object({
  trace_id: z.string(),
  span_id: z.string(),
  matched: z.array(z.string()).min(2),
  resolved_to: z.string(),
});
export type SpanGenerationConflict = z.infer<typeof SpanGenerationConflict>;

export const UnmappedSpan = z.object({
  trace_id: z.string(),
  span_id: z.string(),
  name: z.string(),
  reason: z.string(),
});
export type UnmappedSpan = z.infer<typeof UnmappedSpan>;

export const MissingField = z.object({
  event_type: z.string(),
  span_id: z.string(),
  field: z.string(),
});
export type MissingField = z.infer<typeof MissingField>;

/** Population rate for one scoreable field on one event type. */
export const FieldPopulation = z.object({
  event_type: z.string(),
  field: z.string(),
  populated: z.number().int().nonnegative(),
  total: z.number().int().nonnegative(),
  rate: z.number().min(0).max(1),
});
export type FieldPopulation = z.infer<typeof FieldPopulation>;

/**
 * A capability is the stage-2 proxy for control evaluability: a named
 * category of evidence the batch can or cannot support. When the
 * crosswalk lands, controls reference capabilities so "unevaluable"
 * verdicts trace back to exactly what the telemetry could not say.
 */
export const Capability = z.object({
  id: z.string(),
  description: z.string(),
  status: z.enum(["available", "degraded", "unavailable"]),
  reason: z.string().optional(),
});
export type Capability = z.infer<typeof Capability>;

export const CompletenessReport = z.object({
  /** spans_mapped / spans_seen; 1 for an empty batch. */
  mapped_ratio: z.number().min(0).max(1),
  field_population: z.array(FieldPopulation),
  capabilities: z.array(Capability),
});
export type CompletenessReport = z.infer<typeof CompletenessReport>;

export const NormalizedBatch = z.object({
  schema_version: z.literal(EVENT_SCHEMA_VERSION),
  source: z.object({
    format: z.enum(["otlp-json"]),
    files: z.array(z.string()),
  }),
  /** Every generation whose fingerprint fired, strongest first. */
  detections: z.array(GenerationDetection),
  counts: z.object({
    spans_seen: z.number().int().nonnegative(),
    spans_mapped: z.number().int().nonnegative(),
    spans_unmapped: z.number().int().nonnegative(),
  }),
  events: Events,
  /** Spans no rule claimed. Enumerated, never dropped silently. */
  unmapped: z.array(UnmappedSpan),
  /** Required-by-model fields a mapped span could not populate. */
  missing_fields: z.array(MissingField),
  /** Spans that matched rules from more than one generation. */
  conflicts: z.array(SpanGenerationConflict),
  completeness: CompletenessReport,
});
export type NormalizedBatch = z.infer<typeof NormalizedBatch>;
