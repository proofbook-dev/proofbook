import { reportCommand } from "./commands/report.js";
import { sealCommand } from "./commands/seal.js";
import { verifyCommand } from "./commands/verify.js";
import { chainCommand } from "./commands/chain.js";
import { gateCommand } from "./commands/gate.js";
import { pullCommand, pullForCommand } from "./commands/pull.js";
import { exportCommand } from "./commands/export.js";
import { explainCommand } from "./commands/explain.js";
import { pushCommand } from "./commands/push.js";
import { initCommand } from "./commands/init.js";
import { doctorCommand } from "./commands/doctor.js";
import { mcpCommand } from "./commands/mcp.js";
import { loadConfig } from "./config.js";
import {
  answerCommand,
  crosswalkCommand,
  ingestCommand,
  startWatch,
} from "./commands/misc.js";

const HELP = `proofbook · evidence layer for agentic AI systems

  proof init                    detect your stack, write config, explain the clock
                                (.proofbook/config.json: subject + frameworks defaults)
  proof report [traces...]      evaluate traces → Agent Trust Report  (--offline · --traces <dir>)
  proof pull                    fetch traces from a vendor: --source datadog|langfuse|langsmith|tempo|s3
  proof ingest <traces...>      normalise traces into an event batch
  proof watch                   receive OTLP/HTTP JSON spans into ./traces/
  proof seal [traces...]        seal a period: --period 2026-07 | last-month
  proof chain                   the continuity report: periods, gaps, verification
  proof gate                    PR gate: fail when code stops emitting a control's evidence
  proof push [bundle-dir]       send a sealed bundle to the hosted chain
  proofbook verify <bundle-dir>     verify a bundle offline, check by check
  proof answer <questions.csv>  draft questionnaire answers from evidence
  proof crosswalk list          list frameworks and controls
  proof crosswalk show <id>     show one control
  proof explain <topic>         a coverage gap → the engineering task that closes it
  proof export <bundle-dir>     evidence for GRC platforms: --format vanta|drata
  proof doctor                  diagnostics: generations, mapping, capabilities, chain
  proof mcp                     read-only MCP server over stdio for coding agents

  Options: --out <path> · --subject <name> · --frameworks <a,b> · --previous <root> · --port <n>
           gate: --baseline <git-ref> (read the lock from that ref) · --write (rebuild the lock)
           --json on report/verify/gate/doctor: machine-readable output, stable schema

  Exit codes: 0 clean · 1 tool error · 2 controls regressed or bundle invalid
              3 insufficient data · 4 provenance expectations unmet

  Local, offline, no account. Traces never leave this machine;
  reports and bundles contain digests, never content.`;

interface Parsed {
  command: string | undefined;
  positional: string[];
  flags: Record<string, string>;
}

function parseArgs(argv: string[]): Parsed {
  const [command, ...rest] = argv;
  const positional: string[] = [];
  const flags: Record<string, string> = {};
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i]!;
    if (arg.startsWith("--")) {
      // A flag only consumes the next token when it is a value, so
      // boolean flags (--offline, --supersede) never eat a neighbour.
      const next = rest[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        flags[arg.slice(2)] = next;
        i += 1;
      } else {
        flags[arg.slice(2)] = "";
      }
    } else {
      positional.push(arg);
    }
  }
  return { command, positional, flags };
}

export async function main(argv: string[], cwd: string): Promise<number> {
  const { command, positional, flags } = parseArgs(argv);
  const log = console.log;
  const config = await loadConfig(cwd);
  const frameworks = flags.frameworks?.split(",").map((f) => f.trim()) ?? config.frameworks;
  const subject = flags.subject ?? config.subject;

  switch (command) {
    case "init":
      return initCommand({ cwd, log });
    case "report": {
      let paths = positional;
      if (flags.traces) paths = [...paths, flags.traces];
      if ("offline" in flags) {
        // Hard guarantee, not a promise: any network attempt throws.
        globalThis.fetch = (() => {
          throw new Error("offline mode: network access refused");
        }) as typeof fetch;
        log("offline: network access is disabled for this run; any attempt would fail loudly.");
      }
      if (flags.source) {
        const pulled = await pullForCommand({
          cwd,
          source: flags.source,
          period: flags.period ?? "last-30d",
          log,
        });
        if (!pulled) return 1;
        paths = [...pulled, ...positional];
      }
      return reportCommand({
        cwd,
        paths,
        out: flags.out,
        subject,
        frameworks,
        json: "json" in flags,
        log,
      });
    }
    case "pull":
      return pullCommand({
        cwd,
        source: flags.source,
        period: flags.period,
        out: flags.out,
        log,
      });
    case "ingest":
      return ingestCommand({ cwd, paths: positional, out: flags.out, log });
    case "seal": {
      let sealPaths = positional;
      if (flags.traces) sealPaths = [...sealPaths, flags.traces];
      if (flags.source) {
        const pulled = await pullForCommand({
          cwd,
          source: flags.source,
          period: flags.period ?? "last-month",
          log,
        });
        if (!pulled) return 1;
        sealPaths = [...pulled, ...positional];
      }
      return sealCommand({
        cwd,
        paths: sealPaths,
        out: flags.out,
        subject,
        frameworks,
        previous: flags.previous,
        period: flags.period,
        supersede: "supersede" in flags,
        sign: flags.sign,
        log,
      });
    }
    case "chain":
      return chainCommand({ cwd, markdown: "markdown" in flags, log });
    case "gate":
      return gateCommand({
        cwd,
        baseline: flags.baseline,
        write: "write" in flags,
        frameworks,
        json: "json" in flags,
        log,
      });
    case "push":
      return pushCommand({ cwd, dir: positional[0], url: flags.url, token: flags.token, log });
    case "verify": {
      const dir = positional[0];
      if (!dir) {
        log("Usage: proofbook verify <bundle-dir> [--expect-key <hex>] [--expect-repo <owner/name>]");
        return 1;
      }
      return verifyCommand({
        cwd,
        dir,
        expectKey: flags["expect-key"],
        expectRepo: flags["expect-repo"],
        json: "json" in flags,
        log,
      });
    }
    case "answer": {
      const csvPath = positional[0];
      if (!csvPath) {
        log("Usage: proof answer <questions.csv> [traces...]");
        return 1;
      }
      return answerCommand({ cwd, csvPath, paths: positional.slice(1), out: flags.out, log });
    }
    case "explain":
      return explainCommand(positional[0], log);
    case "doctor":
      return doctorCommand({ cwd, json: "json" in flags, log });
    case "mcp":
      return mcpCommand({ cwd, subject, frameworks });
    case "export":
      return exportCommand({ dir: positional[0], format: flags.format, out: flags.out, log });
    case "crosswalk":
      return crosswalkCommand({ sub: positional[0], id: positional[1], log });
    case "watch": {
      const handle = await startWatch({
        cwd,
        port: flags.port !== undefined ? Number(flags.port) : undefined,
        out: flags.out,
        log,
      });
      log("Ctrl+C to stop.");
      await new Promise<void>((resolve) => {
        process.once("SIGINT", () => void handle.close().then(resolve));
        process.once("SIGTERM", () => void handle.close().then(resolve));
      });
      return 0;
    }
    case undefined:
    case "help":
    case "--help":
      log(HELP);
      return command === undefined ? 1 : 0;
    default:
      log(`Unknown command "${command}".`);
      log("");
      log(HELP);
      return 1;
  }
}

// Direct execution (development: `pnpm proofbook ...` runs this via tsx).
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  process.exitCode = await main(process.argv.slice(2), process.cwd());
}
