import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { parseOtlpJson } from "./otlp.js";
import { loadGenerationRules, type GenerationRules } from "./rules.js";
import { normalize } from "./normalize.js";
import type { NormalizedBatch } from "@proofbook/schema";

export * from "./otlp.js";
export * from "./rules.js";
export * from "./detect.js";
export * from "./completeness.js";
export * from "./normalize.js";

const generationsDir = join(dirname(fileURLToPath(import.meta.url)), "..", "generations");

/** Load a bundled generation rule set by name. */
export async function loadBundledGeneration(name: string): Promise<GenerationRules> {
  const text = await readFile(join(generationsDir, `${name}.yaml`), "utf8");
  return loadGenerationRules(text);
}

/** Load every bundled generation rule set, newest precedence first. */
export async function loadBundledGenerations(): Promise<GenerationRules[]> {
  const files = (await readdir(generationsDir)).filter((f) => f.endsWith(".yaml")).sort();
  const rulesets = await Promise.all(
    files.map(async (f) => loadGenerationRules(await readFile(join(generationsDir, f), "utf8"))),
  );
  // Custom emitters: PROOFBOOK_GENERATIONS=comma,separated,yaml,paths
  // adds user mapping files (the ~20 lines of YAML the docs promise).
  const extra = process.env.PROOFBOOK_GENERATIONS;
  if (extra) {
    for (const path of extra.split(",").map((p) => p.trim()).filter(Boolean)) {
      rulesets.push(loadGenerationRules(await readFile(path, "utf8")));
    }
  }
  return rulesets.sort((a, b) => b.precedence - a.precedence);
}

/**
 * Parse a file that is either one OTLP JSON document or JSONL (one
 * ExportTraceServiceRequest per line, as written by the OTel collector
 * file exporter).
 */
function parseOtlpFileText(text: string): ReturnType<typeof parseOtlpJson> {
  try {
    return parseOtlpJson(JSON.parse(text));
  } catch {
    const spans = [];
    for (const line of text.split("\n")) {
      const trimmed = line.trim();
      if (trimmed === "") continue;
      spans.push(...parseOtlpJson(JSON.parse(trimmed)));
    }
    return spans;
  }
}

export interface NormalizeFileOptions {
  /** Half-open [from, to) window over span start time, in unix nanos. */
  windowFromNano?: bigint | undefined;
  windowToNano?: bigint | undefined;
}

/** Convenience: read OTLP JSON/JSONL files and normalise them in one call. */
export async function normalizeOtlpFiles(
  paths: string[],
  opts: NormalizeFileOptions = {},
): Promise<NormalizedBatch> {
  const rulesets = await loadBundledGenerations();
  let spans = [];
  for (const path of [...paths].sort()) {
    spans.push(...parseOtlpFileText(await readFile(path, "utf8")));
  }
  if (opts.windowFromNano !== undefined || opts.windowToNano !== undefined) {
    spans = spans.filter(
      (s) =>
        (opts.windowFromNano === undefined || s.startNano >= opts.windowFromNano) &&
        (opts.windowToNano === undefined || s.startNano < opts.windowToNano),
    );
  }
  spans.sort((a, b) =>
    a.startNano < b.startNano ? -1 : a.startNano > b.startNano ? 1 : a.spanId < b.spanId ? -1 : 1,
  );
  return normalize({ spans, rulesets, files: paths.map((p) => p.split("/").at(-1)!) });
}
