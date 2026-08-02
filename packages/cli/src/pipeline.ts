import { basename } from "node:path";
import type { FrameworkEvaluation, NormalizedBatch } from "@proofbook/schema";
import { normalizeOtlpFiles } from "@proofbook/normalize";
import { loadCrosswalkDir, type LoadedCrosswalk } from "@proofbook/crosswalk";
import { evaluateFramework } from "@proofbook/engine";

/** The shared path from trace files to evaluations. */
export interface PipelineResult {
  batch: NormalizedBatch;
  evaluations: FrameworkEvaluation[];
  frameworks: Map<string, LoadedCrosswalk>;
}

export async function runPipeline(
  paths: string[],
  frameworkFilter?: string[],
): Promise<PipelineResult> {
  const batch = await normalizeOtlpFiles(paths);
  const frameworks = await loadCrosswalkDir();
  const selected = [...frameworks.entries()].filter(
    ([name]) => !frameworkFilter || frameworkFilter.includes(name),
  );
  if (selected.length === 0) {
    throw new Error(
      `no crosswalk framework matches ${JSON.stringify(frameworkFilter)}; ` +
        `available: ${[...frameworks.keys()].join(", ")}`,
    );
  }
  const evaluations = selected.map(([, cw]) => evaluateFramework(batch, cw));
  return { batch, evaluations, frameworks };
}

export function defaultSubject(cwd: string): string {
  return basename(cwd);
}

export function summaryLine(evaluations: FrameworkEvaluation[]): string {
  return evaluations
    .map((ev) => {
      const s = ev.summary;
      return `${ev.framework}: ${s.evidenced} evidenced · ${s.partially_evidenced} partial · ${s.not_evidenced} not evidenced · ${s.contradicted} contradicted · ${s.unevaluable} unevaluable`;
    })
    .join("\n");
}
