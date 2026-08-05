import { readFile, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { NormalizeError } from "@proofbook/normalize";
import { isLang, LANGS, renderReport } from "@proofbook/report";
import { loadControlTranslations } from "@proofbook/crosswalk";
import { discoverTraces, expandTracePaths } from "../discover.js";
import { defaultSubject, runPipeline, summaryLine } from "../pipeline.js";
import { capabilityImpacts, coverageBlock, discoveryBlock, gapParagraph } from "../transcript.js";
import type { Log } from "../log.js";

export interface ReportOptions {
  cwd: string;
  paths: string[];
  out?: string | undefined;
  subject?: string | undefined;
  frameworks?: string[] | undefined;
  json?: boolean | undefined;
  lang?: string | undefined;
  log: Log;
}

export async function reportCommand(opts: ReportOptions): Promise<number> {
  const { cwd } = opts;
  // In --json mode the transcript goes nowhere; stdout carries exactly
  // one JSON document and nothing else.
  const log: Log = opts.json ? () => {} : opts.log;

  let paths = opts.paths;
  if (paths.length === 0) {
    paths = await discoverTraces(cwd);
    if (paths.length === 0) {
      if (opts.json) {
        opts.log(JSON.stringify({ schema: "proofbook.report/1", error: "no_traces" }, null, 2));
        return 3;
      }
      log("No trace files found.");
      log("");
      log("Looked in: ., ./traces, ./telemetry, ./otel, ./tmp, ./out");
      log("for .json/.jsonl files containing OTLP spans (resourceSpans).");
      const sdks = await detectAgentSdks(cwd);
      log("");
      if (sdks.length > 0) {
        log(`Detected ${sdks.join(", ")} in package.json. To emit traces:`);
        log("  1. proof watch                  (starts a local OTLP receiver on :4318)");
        log("  2. OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318 <run your app>");
        log("  3. proof report");
        log("");
      }
      log("Or point at an existing export:  proof report path/to/traces.jsonl");
      log("Or pull from your vendor:        proof pull --source datadog|langfuse|langsmith|tempo|s3");
      return 3;
    }
    log(`Found ${paths.length} trace file(s):`);
    for (const p of paths) log(`  ${relative(cwd, p) || p}`);
    log("");
  } else {
    // Explicit paths may name directories (e.g. a proof pull output dir).
    paths = await expandTracePaths(paths);
  }

  const langInput = opts.lang ?? "en";
  if (!isLang(langInput)) {
    opts.log(
      `Unknown report language "${langInput}". Available: ${Object.entries(LANGS)
        .map(([code, l]) => `${code} (${l.name})`)
        .join(", ")}.`,
    );
    return 1;
  }

  let result;
  try {
    result = await runPipeline(paths, opts.frameworks);
  } catch (err) {
    if (err instanceof NormalizeError) {
      opts.log(opts.json ? JSON.stringify({ schema: "proofbook.report/1", error: err.message }) : err.message);
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
    lang: langInput,
    controlTranslations: await loadControlTranslations(langInput),
  });

  const htmlPath = opts.out ?? join(cwd, "proofbook-report.html");
  const jsonPath = htmlPath.replace(/\.html$/, "") + ".json";
  await writeFile(htmlPath, html);
  // The JSON companion carries the findings, not the raw event lists:
  // at millions of events the full batch is a multi-gigabyte file
  // nobody asked for. Events live in the (optional) sealed archive.
  await writeFile(
    jsonPath,
    JSON.stringify(
      {
        batch: {
          schema_version: result.batch.schema_version,
          source: result.batch.source,
          detections: result.batch.detections,
          counts: result.batch.counts,
          completeness: result.batch.completeness,
          unmapped: result.batch.unmapped,
          missing_fields: result.batch.missing_fields,
          conflicts: result.batch.conflicts,
        },
        evaluations: result.evaluations,
      },
      null,
      2,
    ),
  );

  if (opts.json) {
    const impacts = capabilityImpacts(result.batch, [...result.frameworks.values()]);
    opts.log(
      JSON.stringify(
        {
          schema: "proofbook.report/1",
          subject: opts.subject ?? defaultSubject(cwd),
          files: paths.length,
          counts: result.batch.counts,
          detections: result.batch.detections,
          capabilities: impacts,
          evaluations: result.evaluations.map((ev) => ({
            framework: ev.framework,
            summary: ev.summary,
            controls: ev.controls.map((c) => ({
              control_id: c.control_id,
              verdict: c.verdict,
            })),
          })),
          outputs: { html: htmlPath, json: jsonPath },
        },
        null,
        2,
      ),
    );
    return 0;
  }

  discoveryBlock(result.batch, paths.length, log);
  const impacts = capabilityImpacts(result.batch, [...result.frameworks.values()]);
  coverageBlock(impacts, log);
  log(summaryLine(result.evaluations));
  log("");
  log(`report:  ${htmlPath}`);
  log(`json:    ${jsonPath}`);
  log(`bundle:  not sealed (proof seal --period last-month produces a signed bundle)`);
  gapParagraph(impacts, log);
  return 0;
}

/** Agent SDKs worth naming in the empty-path recipe. */
const KNOWN_SDKS = [
  "@anthropic-ai/sdk", "ai", "@ai-sdk/anthropic", "@ai-sdk/openai",
  "langchain", "@langchain/core", "llamaindex", "@mastra/core",
  "@openai/agents", "openai",
];

async function detectAgentSdks(cwd: string): Promise<string[]> {
  try {
    const pkg = JSON.parse(await readFile(join(cwd, "package.json"), "utf8")) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    const deps = { ...pkg.dependencies, ...pkg.devDependencies };
    return KNOWN_SDKS.filter((name) => name in deps);
  } catch {
    return [];
  }
}
