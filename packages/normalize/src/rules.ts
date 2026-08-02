/**
 * The declarative rule set.
 *
 * A generation file describes, as data, how one generation of telemetry
 * conventions maps onto the internal event model. New framework quirks
 * must be a YAML change, not a code change: this file is the maintenance
 * surface of the whole business, so the interpreter stays small and the
 * expressiveness lives in the rule format.
 */

import { z } from "zod";
import { parse as parseYaml } from "yaml";
import type { ParsedSpan } from "./otlp.js";

const FieldExtractor = z.object({
  /** Single attribute key. */
  attr: z.string().optional(),
  /** First present attribute wins. */
  attr_first: z.array(z.string()).optional(),
  /**
   * Template with `{i}`, e.g. "gen_ai.prompt.{i}.content". Collects
   * consecutive indexed attributes from 0 and joins them with newlines.
   * Used for the legacy flat message attributes.
   */
  attr_indexed: z.string().optional(),
  /** Regex over the span name; capture group 1 is the value. */
  from_span_name: z.string().optional(),
  /** If the extracted value is an array, take element 0. */
  first_element: z.boolean().optional(),
  /** Missing value invalidates the event (span goes to unmapped). */
  required: z.boolean().optional(),
  /** Missing value is legal but degrades evaluability; recorded in missing_fields. */
  expected: z.boolean().optional(),
});
export type FieldExtractor = z.infer<typeof FieldExtractor>;

const Match: z.ZodType<MatchSpec> = z.lazy(() =>
  z.object({
    attr_in: z.record(z.array(z.string())).optional(),
    attr_present: z.array(z.string()).optional(),
    name_regex: z.string().optional(),
    any: z.array(Match).optional(),
  }),
);
export interface MatchSpec {
  attr_in?: Record<string, string[]> | undefined;
  attr_present?: string[] | undefined;
  name_regex?: string | undefined;
  any?: MatchSpec[] | undefined;
}

const Mapping = z.object({
  event: z.enum(["AgentRun", "ModelCall", "ToolCall", "HumanCheckpoint"]),
  match: Match,
  fields: z.record(FieldExtractor).default({}),
  /** Values here are hashed into ContentRefs; plaintext never leaves the extractor. */
  content_refs: z.record(FieldExtractor).default({}),
  /**
   * Generation-independent mapping (the proofbook.* extension
   * attributes). Appears identically in every generation file; matching
   * several of them is expected and is not a generation conflict.
   */
  shared: z.boolean().default(false),
});
export type Mapping = z.infer<typeof Mapping>;

const FingerprintSignal = z.union([
  z.object({ kind: z.literal("attr_present"), key: z.string(), weight: z.number() }),
  z.object({ kind: z.literal("attr_prefix"), prefix: z.string(), weight: z.number() }),
]);
export type FingerprintSignal = z.infer<typeof FingerprintSignal>;

export const GenerationRules = z.object({
  generation: z.string(),
  description: z.string(),
  /** Higher = newer. The conflict resolver prefers the newest generation. */
  precedence: z.number().int(),
  fingerprint: z.object({ signals: z.array(FingerprintSignal) }),
  mappings: z.array(Mapping),
});
export type GenerationRules = z.infer<typeof GenerationRules>;

export function loadGenerationRules(yamlText: string): GenerationRules {
  return GenerationRules.parse(parseYaml(yamlText));
}

export function matches(span: ParsedSpan, m: MatchSpec): boolean {
  if (m.any) return m.any.some((sub) => matches(span, sub));
  if (m.attr_in) {
    for (const [key, values] of Object.entries(m.attr_in)) {
      const v = span.attrs[key];
      if (typeof v !== "string" || !values.includes(v)) return false;
    }
  }
  if (m.attr_present) {
    for (const key of m.attr_present) {
      if (span.attrs[key] === undefined) return false;
    }
  }
  if (m.name_regex) {
    if (!new RegExp(m.name_regex).test(span.name)) return false;
  }
  return true;
}

/** Extract a raw value for one field. Returns undefined when absent. */
export function extract(span: ParsedSpan, ex: FieldExtractor): unknown {
  let value: unknown;
  if (ex.attr !== undefined) value = span.attrs[ex.attr];
  if (value === undefined && ex.attr_first) {
    for (const key of ex.attr_first) {
      if (span.attrs[key] !== undefined) {
        value = span.attrs[key];
        break;
      }
    }
  }
  if (value === undefined && ex.attr_indexed) {
    const parts: string[] = [];
    for (let i = 0; ; i += 1) {
      const v = span.attrs[ex.attr_indexed.replace("{i}", String(i))];
      if (v === undefined) break;
      parts.push(typeof v === "string" ? v : JSON.stringify(v));
    }
    if (parts.length > 0) value = parts.join("\n");
  }
  if (value === undefined && ex.from_span_name) {
    const m = span.name.match(new RegExp(ex.from_span_name));
    if (m?.[1] !== undefined) value = m[1];
  }
  if (ex.first_element && Array.isArray(value)) value = value[0];
  return value;
}
