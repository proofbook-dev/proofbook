import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { dirname, join } from "node:path";
import { loadCrosswalkDir } from "@proofbook/crosswalk";
import { normalizeOtlpFiles, NormalizeError } from "@proofbook/normalize";
import { discoverTraces } from "../discover.js";
import { runPipeline } from "../pipeline.js";
import type { Log } from "../log.js";

/* ---------------- ingest ---------------- */

export async function ingestCommand(opts: {
  cwd: string;
  paths: string[];
  out?: string | undefined;
  log: Log;
}): Promise<number> {
  const { log } = opts;
  if (opts.paths.length === 0) {
    log("Nothing to ingest. Usage: proof ingest <trace files...>");
    return 1;
  }
  let batch;
  try {
    batch = await normalizeOtlpFiles(opts.paths);
  } catch (err) {
    if (err instanceof NormalizeError) {
      log(err.message);
      return 1;
    }
    throw err;
  }
  const out = opts.out ?? join(opts.cwd, ".proofbook", "batch.json");
  await mkdir(dirname(out), { recursive: true });
  await writeFile(out, JSON.stringify(batch, null, 2));
  const c = batch.counts;
  log(`${c.spans_seen} spans → ${c.spans_mapped} mapped, ${c.spans_unmapped} unmapped`);
  log(`events: ${Object.entries(batch.events)
    .filter(([, list]) => (list as unknown[]).length > 0)
    .map(([k, list]) => `${k}=${(list as unknown[]).length}`)
    .join(" ")}`);
  log(`batch:  ${out}`);
  return 0;
}

/* ---------------- crosswalk ---------------- */

export async function crosswalkCommand(opts: {
  sub: string | undefined;
  id?: string | undefined;
  log: Log;
}): Promise<number> {
  const { log } = opts;
  const frameworks = await loadCrosswalkDir();

  if (opts.sub === "list" || opts.sub === undefined) {
    for (const [name, cw] of frameworks) {
      log(`${name} (${cw.doc.version}) · crosswalk ${cw.doc.crosswalk_version} · ${cw.doc.controls.length} controls · pin ${cw.pin.slice(0, 23)}…`);
      for (const control of cw.doc.controls) {
        log(`  ${control.id.padEnd(28)} ${control.title}`);
      }
    }
    return 0;
  }

  if (opts.sub === "show") {
    for (const cw of frameworks.values()) {
      const control = cw.doc.controls.find((c) => c.id === opts.id);
      if (!control) continue;
      log(`${control.id}${control.article ? ` · ${control.article}` : ""}`);
      log(control.title);
      log("");
      log(control.requirement_summary.trim());
      log("");
      for (const a of control.assertions) {
        log(`  [${a.source_class}] ${a.id}`);
        log(`    ${a.description}`);
        log(`    ${a.expression}`);
      }
      return 0;
    }
    log(`No control named "${opts.id}". Try: proof crosswalk list`);
    return 1;
  }

  log(`Unknown subcommand "${opts.sub}". Usage: proof crosswalk list|show <control-id>`);
  return 1;
}

/* ---------------- watch ---------------- */

export interface WatchHandle {
  port: number;
  close: () => Promise<void>;
}

export async function startWatch(opts: {
  cwd: string;
  port?: number | undefined;
  out?: string | undefined;
  log: Log;
}): Promise<WatchHandle> {
  const out = opts.out ?? join(opts.cwd, "traces", "received.jsonl");
  await mkdir(dirname(out), { recursive: true });

  const server = createServer((req, res) => {
    if (req.method === "POST" && req.url === "/v1/traces") {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        void (async () => {
          try {
            const body = Buffer.concat(chunks).toString("utf8");
            JSON.parse(body); // shape-check before persisting
            await appendFile(out, body.replaceAll("\n", " ") + "\n");
            res.writeHead(200, { "content-type": "application/json" }).end("{}");
          } catch {
            res.writeHead(400).end('{"error":"expected OTLP JSON"}');
          }
        })();
      });
      return;
    }
    res.writeHead(404).end();
  });

  await new Promise<void>((resolve) => server.listen(opts.port ?? 4318, resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : (opts.port ?? 4318);
  opts.log(`Receiving OTLP/HTTP JSON on http://localhost:${port}/v1/traces`);
  opts.log(`Appending to ${out} - point OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:${port} at it.`);
  return {
    port,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

/* ---------------- answer ---------------- */

/**
 * Draft questionnaire answers from evidence, without a model and
 * without invention: keyword-match each question against crosswalk
 * controls; matched questions cite the control's verdict and evidence
 * counts, unmatched questions say "needs-review". A confidently wrong
 * answer is a liability, so unmatched never guesses.
 */
const STOPWORDS = new Set([
  "the", "and", "for", "are", "your", "you", "how", "what", "which", "with",
  "does", "each", "that", "this", "have", "been", "was", "were", "any", "all",
  "describe", "provide", "please", "including", "system", "systems",
]);

function tokens(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .split(/[^a-z]+/)
      .filter((w) => w.length > 3 && !STOPWORDS.has(w)),
  );
}

function csvField(s: string): string {
  return `"${s.replaceAll('"', '""')}"`;
}

export async function answerCommand(opts: {
  cwd: string;
  csvPath: string;
  paths: string[];
  out?: string | undefined;
  log: Log;
}): Promise<number> {
  const { log } = opts;
  let questions: string[];
  try {
    questions = (await readFile(opts.csvPath, "utf8"))
      .split("\n")
      .map((l) => l.trim().replace(/^"|"$/g, ""))
      .filter((l) => l !== "");
  } catch {
    log(`Cannot read ${opts.csvPath}. Expected a CSV/text file with one question per line.`);
    return 1;
  }

  let paths = opts.paths;
  if (paths.length === 0) paths = await discoverTraces(opts.cwd);
  if (paths.length === 0) {
    log("No traces found to answer from. Answers without evidence would be fabrication.");
    return 1;
  }
  const { evaluations } = await runPipeline(paths);
  const controls = evaluations.flatMap((ev) => ev.controls);

  const rows = [["question", "status", "controls", "basis"].join(",")];
  let matched = 0;
  for (const question of questions) {
    const q = tokens(question);
    const scored = controls
      .map((c) => {
        const text = tokens(`${c.title} ${c.requirement_summary}`);
        const overlap = [...q].filter((w) => text.has(w)).length;
        return { c, overlap };
      })
      .filter((s) => s.overlap >= 2)
      .sort((a, b) => b.overlap - a.overlap)
      .slice(0, 2);

    if (scored.length === 0) {
      rows.push(
        [csvField(question), "needs-review", "", csvField("No matching control; a drafted answer here would be invention.")].join(","),
      );
      continue;
    }
    matched += 1;
    const best = scored[0]!.c;
    const cited = scored.map((s) => s.c.control_id).join(" ");
    const evidence = best.assertions
      .map((a) => `${a.assertion_id}: ${a.verdict}${a.evidence ? ` (${a.evidence.count} events)` : ""}`)
      .join("; ");
    rows.push([csvField(question), best.verdict, csvField(cited), csvField(evidence)].join(","));
  }

  const out = opts.out ?? join(opts.cwd, "proofbook-answers.csv");
  await writeFile(out, rows.join("\n") + "\n");
  log(`${matched} of ${questions.length} question(s) matched to controls; the rest are marked needs-review.`);
  log(`answers: ${out}`);
  return 0;
}
