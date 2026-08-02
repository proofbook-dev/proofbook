import { reportCommand } from "./commands/report.js";
import { sealCommand } from "./commands/seal.js";
import { verifyCommand } from "./commands/verify.js";
import { chainCommand } from "./commands/chain.js";
import { gateCommand } from "./commands/gate.js";
import { pushCommand } from "./commands/push.js";
import { initCommand } from "./commands/init.js";
import {
  answerCommand,
  crosswalkCommand,
  ingestCommand,
  startWatch,
} from "./commands/misc.js";

const HELP = `proofbook · evidence layer for agentic AI systems

  proof init                    detect your stack, write config, explain the clock
  proof report [traces...]      evaluate traces → Agent Trust Report (HTML + JSON)
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

  Options: --out <path> · --subject <name> · --frameworks <a,b> · --previous <root> · --port <n>
           gate: --baseline <git-ref> (read the lock from that ref) · --write (rebuild the lock)

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
      flags[arg.slice(2)] = rest[i + 1] ?? "";
      i += 1;
    } else {
      positional.push(arg);
    }
  }
  return { command, positional, flags };
}

export async function main(argv: string[], cwd: string): Promise<number> {
  const { command, positional, flags } = parseArgs(argv);
  const log = console.log;
  const frameworks = flags.frameworks?.split(",").map((f) => f.trim());

  switch (command) {
    case "init":
      return initCommand({ cwd, log });
    case "report":
      return reportCommand({
        cwd,
        paths: positional,
        out: flags.out,
        subject: flags.subject,
        frameworks,
        log,
      });
    case "ingest":
      return ingestCommand({ cwd, paths: positional, out: flags.out, log });
    case "seal":
      return sealCommand({
        cwd,
        paths: positional,
        out: flags.out,
        subject: flags.subject,
        frameworks,
        previous: flags.previous,
        period: flags.period,
        supersede: "supersede" in flags,
        sign: flags.sign,
        log,
      });
    case "chain":
      return chainCommand({ cwd, markdown: "markdown" in flags, log });
    case "gate":
      return gateCommand({
        cwd,
        baseline: flags.baseline,
        write: "write" in flags,
        frameworks,
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
