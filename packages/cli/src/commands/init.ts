import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { defaultSubject } from "../pipeline.js";
import type { Log } from "../log.js";

/**
 * Detect the stack, write a starting config, and say the one thing the
 * user must hear at install time: backfill is impossible. Every month
 * before sealing starts is a month of evidence that can never exist.
 */

const NODE_MARKERS: Record<string, string> = {
  "@traceloop/node-server-sdk": "OpenLLMetry (emits legacy gen_ai flat attributes - supported)",
  langfuse: "Langfuse SDK (pull adapter planned; local OTLP export works today)",
  langchain: "LangChain (OTel export supported)",
  "@langchain/core": "LangChain (OTel export supported)",
  ai: "Vercel AI SDK (enable experimental_telemetry; partial gen_ai attributes)",
  openai: "OpenAI SDK (instrument via OpenLLMetry or OTel GenAI instrumentation)",
  "@anthropic-ai/sdk": "Anthropic SDK (instrument via OTel GenAI instrumentation)",
};

const PY_MARKERS: Record<string, string> = {
  "traceloop-sdk": "OpenLLMetry (emits legacy gen_ai flat attributes - supported)",
  openllmetry: "OpenLLMetry (supported)",
  langfuse: "Langfuse SDK",
  "opentelemetry-instrumentation-openai": "OTel OpenAI instrumentation",
};

export interface InitOptions {
  cwd: string;
  log: Log;
}

export async function initCommand(opts: InitOptions): Promise<number> {
  const { cwd, log } = opts;
  const found: string[] = [];

  try {
    const pkg = JSON.parse(await readFile(join(cwd, "package.json"), "utf8")) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    const deps = { ...pkg.dependencies, ...pkg.devDependencies };
    for (const [dep, note] of Object.entries(NODE_MARKERS)) {
      if (deps[dep]) found.push(`${dep} - ${note}`);
    }
  } catch {
    /* no package.json is fine */
  }
  for (const file of ["requirements.txt", "pyproject.toml"]) {
    try {
      const text = await readFile(join(cwd, file), "utf8");
      for (const [marker, note] of Object.entries(PY_MARKERS)) {
        if (text.includes(marker)) found.push(`${marker} (${file}) - ${note}`);
      }
    } catch {
      /* absent is fine */
    }
  }

  const configPath = join(cwd, "proofbook.yml");
  let wroteConfig = false;
  try {
    await readFile(configPath, "utf8");
    log(`proofbook.yml already exists - leaving it alone.`);
  } catch {
    await writeFile(
      configPath,
      `# Proofbook configuration
subject: ${defaultSubject(cwd)}
sources:
  - type: otlp-json
    # Where your exported traces land. The collector file exporter
    # writes JSONL here; proof report also discovers these itself.
    paths:
      - ./traces/*.jsonl
frameworks:
  - eu-ai-act
`,
    );
    wroteConfig = true;
  }

  log("Stack detection:");
  if (found.length > 0) for (const f of found) log(`  · ${f}`);
  else log("  · No known LLM instrumentation found in package.json / requirements - point your OTel exporter at a file and proof report will find it.");
  log("");
  if (wroteConfig) log("Wrote proofbook.yml (edit sources to match where your traces land).");
  log("");
  log("The clock that matters: backfill is impossible.");
  log("Trace stores keep days, audits ask about months. Datadog keeps LLM traces");
  log("15 days by default; Langfuse Core keeps 90. Whatever is not sealed while");
  log("it exists is gone permanently - installing in January cannot evidence");
  log("last year. Start the scheduled seal now, not when the questionnaire lands:");
  log("");
  log("  proof report          # see what your telemetry can evidence today");
  log("  proof seal            # seal the current window into the chain");
  return 0;
}
