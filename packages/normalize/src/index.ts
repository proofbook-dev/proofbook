import { readdir, readFile, stat } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { parseOtlpJson } from "./otlp.js";
import { loadGenerationRules, type GenerationRules } from "./rules.js";
import { createNormalizer, NormalizeError } from "./normalize.js";
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
      // Never spread an unbounded array into push: at tens of
      // thousands of spans the argument list overflows the call stack.
      for (const span of parseOtlpJson(JSON.parse(trimmed))) spans.push(span);
    }
    return spans;
  }
}

export interface NormalizeFileOptions {
  /** Half-open [from, to) window over span start time, in unix nanos. */
  windowFromNano?: bigint | undefined;
  windowToNano?: bigint | undefined;
}

/** Whole-file reads only below this; larger files must be JSONL. */
const WHOLE_FILE_MAX = 256 * 1024 * 1024;

/**
 * Read OTLP JSON/JSONL files and normalise them in one call.
 *
 * JSONL streams line by line into the normalizer, so a multi-gigabyte
 * month is processed span by span and never held whole: neither as a
 * string (Node caps strings near 1 GB) nor as a parsed span array.
 * Single-document JSON files are read whole, with a size guard that
 * names the fix instead of dying inside V8.
 */
export async function normalizeOtlpFiles(
  paths: string[],
  opts: NormalizeFileOptions = {},
): Promise<NormalizedBatch> {
  const rulesets = await loadBundledGenerations();
  const machine = createNormalizer(rulesets, paths.map((p) => p.split("/").at(-1)!));

  const inWindow = (startNano: bigint) =>
    (opts.windowFromNano === undefined || startNano >= opts.windowFromNano) &&
    (opts.windowToNano === undefined || startNano < opts.windowToNano);

  for (const path of [...paths].sort()) {
    const rl = createInterface({
      input: createReadStream(path, { encoding: "utf8" }),
      crlfDelay: Infinity,
    });
    let mode: "unknown" | "jsonl" | "whole" = "unknown";
    for await (const line of rl) {
      const trimmed = line.trim();
      if (trimmed === "") continue;
      if (mode === "unknown") {
        try {
          JSON.parse(trimmed);
          mode = "jsonl";
        } catch {
          // Pretty-printed single document: fall back to a whole read.
          mode = "whole";
          rl.close();
          break;
        }
      }
      for (const span of parseOtlpJson(JSON.parse(trimmed))) {
        if (inWindow(span.startNano)) machine.add(span);
      }
    }
    if (mode === "whole") {
      const { size } = await stat(path);
      if (size > WHOLE_FILE_MAX) {
        throw new NormalizeError(
          `${path} is ${(size / 1024 / 1024).toFixed(0)} MB of single-document JSON; ` +
            `files this large must be JSONL (one OTLP document per line, the OTel ` +
            `collector file exporter's format).`,
        );
      }
      for (const span of parseOtlpFileText(await readFile(path, "utf8"))) {
        if (inWindow(span.startNano)) machine.add(span);
      }
    }
  }
  return machine.finish();
}
