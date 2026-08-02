import type { GenerationDetection } from "@proofbook/schema";
import type { ParsedSpan } from "./otlp.js";
import type { GenerationRules } from "./rules.js";

/**
 * Fingerprint a span batch against every known generation.
 *
 * Real batches routinely contain more than one generation at once, so
 * detection reports all of them, strongest first. If nothing clears the
 * floor the normaliser refuses rather than guesses: an evidence tool
 * that guesses at its input format produces confident nonsense, which
 * is worse than an error.
 */
export const CONFIDENCE_FLOOR = 0.5;

export function detectGeneration(
  spans: ParsedSpan[],
  rules: GenerationRules,
): GenerationDetection {
  const fired: string[] = [];
  let confidence = 0;

  for (const signal of rules.fingerprint.signals) {
    let hit = false;
    if (signal.kind === "attr_present") {
      hit = spans.some((s) => s.attrs[signal.key] !== undefined);
      if (hit) fired.push(`attr_present:${signal.key}`);
    } else {
      hit = spans.some((s) =>
        Object.keys(s.attrs).some((k) => k.startsWith(signal.prefix)),
      );
      if (hit) fired.push(`attr_prefix:${signal.prefix}`);
    }
    if (hit) confidence += signal.weight;
  }

  return {
    generation: rules.generation,
    confidence: Math.min(1, Number(confidence.toFixed(4))),
    signals: fired,
  };
}

/** All generations whose fingerprint fired at all, strongest first. */
export function detectGenerations(
  spans: ParsedSpan[],
  rulesets: GenerationRules[],
): GenerationDetection[] {
  return rulesets
    .map((rules) => detectGeneration(spans, rules))
    .filter((d) => d.confidence > 0)
    .sort(
      (a, b) =>
        b.confidence - a.confidence || a.generation.localeCompare(b.generation),
    );
}
