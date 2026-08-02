import { join } from "node:path";
import { liveSealed, openStore, verifyChain } from "@proofbook/store";
import type { Log } from "../log.js";

/**
 * `proof chain`: the continuity report. Every sealed period, every gap,
 * every supersession, and a full verification walk. `--markdown` emits
 * the same thing for a CI job summary.
 */
export interface ChainOptions {
  cwd: string;
  markdown?: boolean | undefined;
  log: Log;
}

export async function chainCommand(opts: ChainOptions): Promise<number> {
  const { log } = opts;
  const store = await openStore(join(opts.cwd, ".proofbook", "store"));

  if (store.chain.entries.length === 0) {
    log("The period chain is empty. Seal a period to start it: proof seal --period last-month");
    return 0;
  }

  const report = await verifyChain(store);

  if (opts.markdown) {
    log("## Proofbook evidence chain");
    log("");
    log("| Period | Status | Root | Note |");
    log("|---|---|---|---|");
    for (const e of store.chain.entries) {
      const status =
        e.kind === "gap" ? "🕳 GAP" : e.superseded_by !== undefined ? "superseded" : "sealed";
      log(`| ${e.label} | ${status} | ${e.root ? `\`${e.root.slice(0, 16)}…\`` : ""} | ${e.note ?? ""} |`);
    }
    log("");
    log(
      report.ok
        ? `✅ Chain verifies: ${report.sealed} sealed period(s), ${report.gaps.length} gap(s), ${report.superseded} superseded.`
        : `❌ Chain INVALID: ${report.problems.map((p) => `${p.label}: ${p.problem}`).join("; ")}`,
    );
    return report.ok ? 0 : 1;
  }

  for (const e of store.chain.entries) {
    if (e.kind === "gap") {
      log(`🕳  ${e.label}  GAP  ${e.note ?? ""}`);
    } else {
      const flag = e.superseded_by !== undefined ? "superseded" : "sealed";
      log(`✔  ${e.label}  ${flag}  root ${e.root?.slice(0, 20)}…${e.note ? `  (${e.note})` : ""}`);
    }
  }
  log("");
  if (report.ok) {
    log(
      `Chain verifies: ${report.sealed} sealed period(s), ${report.gaps.length} explicit gap(s), ${report.superseded} superseded.`,
    );
    const head = liveSealed(store).at(-1);
    if (head) log(`head: ${head.label} · ${head.root}`);
  } else {
    for (const p of report.problems) log(`PROBLEM  ${p.label}: ${p.problem}`);
    log("");
    log("Chain INVALID. A broken link or altered bundle is exactly what an auditor");
    log("would find; fix it before anyone else does.");
  }
  return report.ok ? 0 : 1;
}
