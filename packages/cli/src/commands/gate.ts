import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { loadCrosswalkDir, type LoadedCrosswalk } from "@proofbook/crosswalk";
import type { FrameworkEvaluation } from "@proofbook/schema";
import {
  buildLock,
  compareToLock,
  controlRequirements,
  loadSignalTable,
  lockPath,
  parseLock,
  readLock,
  scanTree,
  writeLock,
  type LockFile,
  type Regression,
} from "@proofbook/gate";

const execFileP = promisify(execFile);

/**
 * `proof gate`: the pull-request instrumentation gate (mode 3).
 *
 * Not a runtime check; production traces do not exist at PR time. The
 * gate asks one question: does this tree still contain code that emits
 * the events backing the controls we have been evidencing? It fails
 * only when a control drops to zero emitting sites, and the failure
 * names the control, the event type and the removed file:line.
 *
 * A missing lock is a pass, not a failure. The gate cannot regress
 * against a baseline that was never recorded, and failing a first-time
 * CI run would teach the team to skip the check before it ever
 * protected anything.
 */

export interface GateOptions {
  cwd: string;
  /** Git ref to read the baseline lock from, e.g. origin/main. */
  baseline?: string | undefined;
  /** Rescan and rewrite the local lock instead of checking. */
  write?: boolean | undefined;
  frameworks?: string[] | undefined;
  log: (message: string) => void;
}

const LOCK_REL = ".proofbook/instrumentation.lock";

async function baselineLock(cwd: string, ref: string): Promise<LockFile | null> {
  try {
    const { stdout } = await execFileP("git", ["show", `${ref}:${LOCK_REL}`], {
      cwd,
      maxBuffer: 16 * 1024 * 1024,
    });
    return parseLock(stdout);
  } catch {
    return null;
  }
}

function printRegression(r: Regression, log: (m: string) => void): void {
  log(`✗ Control ${r.control_id} (${r.title})`);
  log(`  lost its only evidence source: no code site still emits ${r.event_type}.`);
  log(
    r.lost_sites.length === 1
      ? "  the last emitting site, now removed:"
      : "  the last emitting sites, all removed:",
  );
  for (const site of r.lost_sites) {
    log(`    ${site.file}:${site.line} (${site.signal})`);
  }
}

async function selectFrameworks(
  filter: string[] | undefined,
  log: (m: string) => void,
): Promise<[string, LoadedCrosswalk][] | null> {
  const frameworks = await loadCrosswalkDir();
  const selected = [...frameworks.entries()].filter(
    ([name]) => !filter || filter.includes(name),
  );
  if (selected.length === 0) {
    log(`no crosswalk framework matches ${JSON.stringify(filter)}`);
    return null;
  }
  return selected;
}

export async function gateCommand(opts: GateOptions): Promise<number> {
  const { cwd, log } = opts;

  const selected = await selectFrameworks(opts.frameworks, log);
  if (!selected) return 1;

  const table = await loadSignalTable();
  const scan = await scanTree(cwd, table);
  const requirements = controlRequirements(selected.map(([, cw]) => cw));

  if (opts.write) {
    const lock = buildLock({
      requirements,
      sites: scan.sites,
      crosswalk_version: selected[0]![1].doc.crosswalk_version,
      frameworks: selected.map(([name]) => name),
      source: "scan",
    });
    await writeLock(lockPath(cwd), lock);
    const siteCount = Object.values(lock.sites).flat().length;
    log(`wrote ${LOCK_REL}`);
    log(
      `${siteCount} emitting site${siteCount === 1 ? "" : "s"} across ` +
        `${Object.keys(lock.sites).length} event types, ${requirements.length} controls mapped.`,
    );
    log("Commit the lock; the gate diffs future trees against it. Sealing a period");
    log("rewrites it with evidence-backed verdicts, which is the better baseline.");
    return 0;
  }

  const lock = opts.baseline
    ? await baselineLock(cwd, opts.baseline)
    : await readLock(lockPath(cwd));

  if (!lock) {
    if (opts.baseline) {
      log(`No instrumentation lock at ${opts.baseline}:${LOCK_REL}; nothing to enforce.`);
    } else {
      log(`No ${LOCK_REL} in this tree; nothing to enforce.`);
    }
    log("Create a baseline with `proof gate --write` (or seal a period, which writes");
    log("an evidence-backed one) and commit the lock. The gate passes until then.");
    return 0;
  }

  const report = compareToLock(lock, scan.sites);

  if (report.regressions.length > 0) {
    for (const regression of report.regressions) {
      printRegression(regression, log);
      log("");
    }
    const n = report.regressions.length;
    log(`${n} control regression${n === 1 ? "" : "s"}. Merging this leaves the next`);
    log("sealed period unable to evidence the controls above; they will read");
    log("unevaluable, and the evidence chain will say so.");
    return 1;
  }

  log(
    `No control regressions: ${report.enforced.length} controls enforced, ` +
      `${report.unenforced.length} outside the gate's jurisdiction.`,
  );
  return 0;
}

/**
 * Seal-time lock refresh. The lock written here is stronger than a bare
 * scan: it records which controls actually reached an evidenced verdict
 * in the sealed period, so the gate never enforces a control whose
 * telemetry was aspirational. Failure is logged and swallowed; a seal
 * must never fail because a convenience baseline could not be written.
 */
export async function refreshInstrumentationLock(args: {
  cwd: string;
  crosswalks: [string, LoadedCrosswalk][];
  evaluations: FrameworkEvaluation[];
  period?: string | undefined;
  log: (message: string) => void;
}): Promise<void> {
  try {
    const table = await loadSignalTable();
    const scan = await scanTree(args.cwd, table);
    const evidenced = new Map<string, boolean>();
    for (const evaluation of args.evaluations) {
      for (const control of evaluation.controls) {
        evidenced.set(
          control.control_id,
          control.verdict === "evidenced" || control.verdict === "partially_evidenced",
        );
      }
    }
    const lock = buildLock({
      requirements: controlRequirements(args.crosswalks.map(([, cw]) => cw)),
      sites: scan.sites,
      crosswalk_version: args.crosswalks[0]![1].doc.crosswalk_version,
      frameworks: args.crosswalks.map(([name]) => name),
      source: "seal",
      period: args.period,
      evidenced,
    });
    await writeLock(lockPath(args.cwd), lock);
    args.log(`gate:     ${LOCK_REL} refreshed (commit it to keep the PR gate current)`);
  } catch (err) {
    args.log(`note: instrumentation lock not refreshed (${(err as Error).message})`);
  }
}
