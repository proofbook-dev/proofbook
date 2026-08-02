import { writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { NormalizeError } from "@proofbook/normalize";
import { renderReport } from "@proofbook/report";
import { discoverTraces } from "../discover.js";
import { defaultSubject, runPipeline, summaryLine } from "../pipeline.js";
import type { Log } from "../log.js";

export interface ReportOptions {
  cwd: string;
  paths: string[];
  out?: string | undefined;
  subject?: string | undefined;
  frameworks?: string[] | undefined;
  log: Log;
}

export async function reportCommand(opts: ReportOptions): Promise<number> {
  const { cwd, log } = opts;

  let paths = opts.paths;
  if (paths.length === 0) {
    paths = await discoverTraces(cwd);
    if (paths.length === 0) {
      log("No trace files found here.");
      log("");
      log("Looked in this directory and ./traces, ./telemetry, ./otel, ./tmp, ./out");
      log("for .json/.jsonl files containing OTLP spans (resourceSpans).");
      log("");
      log("Point me at a file directly:  proof report path/to/traces.jsonl");
      log("Or receive live spans:        proof watch");
      return 1;
    }
    log(`Found ${paths.length} trace file(s):`);
    for (const p of paths) log(`  ${relative(cwd, p) || p}`);
    log("");
  }

  let result;
  try {
    result = await runPipeline(paths, opts.frameworks);
  } catch (err) {
    if (err instanceof NormalizeError) {
      log(err.message);
      return 1;
    }
    throw err;
  }

  const html = renderReport({
    batch: result.batch,
    evaluations: result.evaluations,
    meta: {
      subject: opts.subject ?? defaultSubject(cwd),
      tool_version: "0.1.0",
      generated_at: new Date().toISOString(),
    },
  });

  const htmlPath = opts.out ?? join(cwd, "proofbook-report.html");
  const jsonPath = htmlPath.replace(/\.html$/, "") + ".json";
  await writeFile(htmlPath, html);
  await writeFile(
    jsonPath,
    JSON.stringify({ batch: result.batch, evaluations: result.evaluations }, null, 2),
  );

  log(summaryLine(result.evaluations));
  const c = result.batch.counts;
  log(`coverage: ${c.spans_mapped} of ${c.spans_seen} spans mapped, ${c.spans_unmapped} unmapped`);
  log("");
  log(`report:  ${htmlPath}`);
  log(`json:    ${jsonPath}`);
  return 0;
}
