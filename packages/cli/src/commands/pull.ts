import { join } from "node:path";
import { parseWindow, pullToDir, getSource, SOURCES, SourceError } from "@proofbook/sources";
import type { Log } from "../log.js";

/**
 * `proof pull`: fetch traces from an observability vendor into local
 * OTLP files, ready for report and seal. Also the fetch step behind
 * `--source` on those commands. Credentials come from the environment,
 * are used for the fetch, and are stored nowhere; the written files
 * contain telemetry only.
 */

export interface PullOptions {
  cwd: string;
  source?: string | undefined;
  period?: string | undefined;
  out?: string | undefined;
  log: Log;
}

export async function pullCommand(opts: PullOptions): Promise<number> {
  const { log } = opts;
  if (!opts.source) {
    log("Usage: proof pull --source <name> [--period last-30d|last-month|YYYY-MM] [--out dir]");
    log("");
    for (const adapter of Object.values(SOURCES)) {
      log(`  ${adapter.name.padEnd(10)} ${adapter.description}`);
      log(`  ${"".padEnd(10)} needs: ${adapter.requiredEnv.join(", ")}`);
      if (adapter.optionalEnv.length > 0) {
        log(`  ${"".padEnd(10)} optional: ${adapter.optionalEnv.join(" · ")}`);
      }
    }
    return 1;
  }
  try {
    const window = parseWindow(opts.period ?? "last-30d");
    const dir = opts.out ?? join(opts.cwd, "traces", opts.source);
    getSource(opts.source);
    const paths = await pullToDir(opts.source, window, dir, { log });
    if (paths.length === 0) {
      log(`No spans found at ${opts.source} between ${window.fromISO} and ${window.toISO}.`);
      log("Nothing was written. Widen the period or check the query scope.");
      return 1;
    }
    log("");
    log(`${paths.length} file${paths.length === 1 ? "" : "s"} written to ${dir}`);
    log(`next:     proof report ${dir}`);
    return 0;
  } catch (err) {
    if (err instanceof SourceError) {
      log(err.message);
      return 1;
    }
    throw err;
  }
}

/** Shared by report/seal `--source`: pull, return the trace paths. */
export async function pullForCommand(args: {
  cwd: string;
  source: string;
  period: string;
  log: Log;
}): Promise<string[] | null> {
  try {
    const window = parseWindow(args.period);
    const dir = join(args.cwd, ".proofbook", "pulled", args.source);
    const paths = await pullToDir(args.source, window, dir, { log: args.log });
    if (paths.length === 0) {
      args.log(`No spans found at ${args.source} for ${args.period}. Nothing to evaluate.`);
      return null;
    }
    args.log(`pulled ${paths.length} trace file${paths.length === 1 ? "" : "s"} from ${args.source}`);
    return paths;
  } catch (err) {
    if (err instanceof SourceError) {
      args.log(err.message);
      return null;
    }
    throw err;
  }
}
