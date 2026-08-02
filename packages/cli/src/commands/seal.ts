import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { NormalizeError, normalizeOtlpFiles } from "@proofbook/normalize";
import { loadCrosswalkDir } from "@proofbook/crosswalk";
import { evaluateFramework } from "@proofbook/engine";
import { refreshInstrumentationLock } from "./gate.js";
import {
  buildBundle,
  generateKeypair,
  readBundleDir,
  signBundle,
  writeBundle,
  type SignedBundle,
  type UnsignedBundle,
} from "@proofbook/seal";
import {
  buildAttestationFiles,
  getGitHubIdentity,
  loadSigstoreSigner,
  type CIIdentity,
  type SigstoreSignFn,
} from "@proofbook/provenance";
import {
  bundleDir,
  isoToNano,
  openStore,
  PeriodError,
  planSeal,
  recordGaps,
  recordSeal,
  recordSupersession,
  resolvePeriod,
  saveStore,
} from "@proofbook/store";
import { discoverTraces } from "../discover.js";
import { defaultSubject, runPipeline, summaryLine } from "../pipeline.js";
import type { Log } from "../log.js";

export interface SealOptions {
  cwd: string;
  paths: string[];
  out?: string | undefined;
  subject?: string | undefined;
  frameworks?: string[] | undefined;
  previous?: string | undefined;
  /** "2026-07", "last-month", "this-month". Enables the period store. */
  period?: string | undefined;
  /** Replace a divergent existing bundle for the period, recording it. */
  supersede?: boolean | undefined;
  /** "local" (default) or "oidc" for Sigstore keyless in CI. */
  sign?: string | undefined;
  log: Log;
  now?: Date | undefined;
}

async function loadKey(cwd: string, log: Log): Promise<string> {
  const dir = join(cwd, ".proofbook");
  const keyPath = join(dir, "key.json");
  try {
    const key = JSON.parse(await readFile(keyPath, "utf8")) as { private_key: string };
    return key.private_key;
  } catch {
    const keys = generateKeypair();
    await mkdir(dir, { recursive: true });
    await writeFile(keyPath, JSON.stringify(keys, null, 2), { mode: 0o600 });
    log(`New local signing key written to .proofbook/key.json - keep it out of version control.`);
    log(`Local keys prove integrity, not identity. CI signing via OIDC is the stronger path.`);
    log("");
    return keys.private_key;
  }
}

async function signAndAttest(
  opts: SealOptions,
  unsigned: UnsignedBundle,
  log: Log,
): Promise<{ signed: SignedBundle; attestation: Map<string, string> }> {
  const privateKey = await loadKey(opts.cwd, log);
  const signed = signBundle(unsigned, privateKey, { created_at: new Date().toISOString() });

  let identity: CIIdentity | null = null;
  let sigstoreSign: SigstoreSignFn | undefined;
  try {
    identity = await getGitHubIdentity(process.env);
  } catch (err) {
    log(`OIDC identity unavailable: ${(err as Error).message}`);
  }
  if (opts.sign === "oidc") {
    if (!identity) {
      log("No CI OIDC identity here - falling back to local signing, which the bundle will say.");
    } else {
      try {
        sigstoreSign = await loadSigstoreSigner();
      } catch (err) {
        log((err as Error).message);
        log("Falling back to local signing.");
      }
    }
  }

  const attestation = await buildAttestationFiles({
    bundle: unsigned,
    identity,
    privateKeyHex: privateKey,
    ...(sigstoreSign ? { sigstoreSign } : {}),
  });
  return { signed, attestation };
}

async function writeAll(
  signed: SignedBundle,
  attestation: Map<string, string>,
  dir: string,
): Promise<void> {
  await writeBundle(signed, dir);
  for (const [path, content] of attestation) {
    await mkdir(dirname(join(dir, path)), { recursive: true });
    await writeFile(join(dir, path), content);
  }
}

export async function sealCommand(opts: SealOptions): Promise<number> {
  const { cwd, log } = opts;

  let paths = opts.paths;
  if (paths.length === 0) {
    paths = await discoverTraces(cwd);
    if (paths.length === 0) {
      log("No trace files found to seal. Run `proof report` first to see what I can see.");
      return 1;
    }
  }

  return opts.period !== undefined ? sealPeriod(opts, paths) : sealAdhoc(opts, paths);
}

/* ------------------------------------------------------------------ */
/* Period mode: the store, continuity, idempotency.                    */
/* ------------------------------------------------------------------ */

async function sealPeriod(opts: SealOptions, paths: string[]): Promise<number> {
  const { cwd, log } = opts;

  let period;
  try {
    period = resolvePeriod(opts.period!, opts.now ?? new Date());
  } catch (err) {
    if (err instanceof PeriodError) {
      log(err.message);
      return 1;
    }
    throw err;
  }

  let batch;
  try {
    batch = await normalizeOtlpFiles(paths, {
      windowFromNano: isoToNano(period.from),
      windowToNano: isoToNano(period.to),
    });
  } catch (err) {
    if (err instanceof NormalizeError) {
      log(err.message);
      return 1;
    }
    throw err;
  }
  if (batch.counts.spans_seen === 0) {
    log(`No spans fall inside ${period.label} (${period.from} → ${period.to}).`);
    log("Check the trace files cover the period; sealing an empty period would record");
    log("an all-unevaluable bundle, which is rarely what you want. Nothing was sealed.");
    return 1;
  }

  const frameworks = await loadCrosswalkDir();
  const selected = [...frameworks.entries()].filter(
    ([name]) => !opts.frameworks || opts.frameworks.includes(name),
  );
  const evaluations = selected.map(([, cw]) => evaluateFramework(batch, cw));

  const store = await openStore(join(cwd, ".proofbook", "store"));
  const plan = planSeal(store, period);
  const subject = opts.subject ?? defaultSubject(cwd);

  if (plan.kind === "duplicate") {
    // Idempotency: same period + same content is a no-op; divergent
    // content is refused unless explicitly superseding. Never a second
    // silent divergent bundle for one period.
    const existingPrevious = await (async () => {
      try {
        const files = await readBundleDir(plan.existing!.dir!);
        return (JSON.parse(files.get("manifest.json")!) as { previous: string | null }).previous;
      } catch {
        return null;
      }
    })();
    const recomputed = buildBundle({
      batch,
      evaluations,
      subject,
      previous_root: existingPrevious,
      period,
    });
    if (recomputed.root === plan.existing!.root) {
      log(
        `${period.label} is already sealed with identical content (root ${recomputed.root.slice(0, 16)}…). Nothing to do.`,
      );
      return 0;
    }
    if (!opts.supersede) {
      log(`${period.label} is already sealed with DIFFERENT content.`);
      log(`  existing root: ${plan.existing!.root}`);
      log(`  recomputed:    ${recomputed.root}`);
      log("Refusing to produce a second divergent bundle for one period. If the new");
      log("content is correct (crosswalk update, fixed traces), re-run with --supersede;");
      log("the old bundle stays in the chain, marked superseded.");
      return 1;
    }
    // The superseding bundle takes the old one's slot in the live
    // chain, so it inherits the old bundle's predecessor; the ledger's
    // superseded_by field records the replacement relationship.
    const superseding = buildBundle({
      batch,
      evaluations,
      subject,
      previous_root: existingPrevious,
      period,
    });
    const { signed, attestation } = await signAndAttest(opts, superseding, log);
    const generation = store.chain.entries.filter((e) => e.label === period.label).length;
    const dir = bundleDir(store, period.label, generation);
    await writeAll(signed, attestation, dir);
    recordSupersession(store, period.label, signed.root);
    recordSeal(store, period, signed.root, dir, new Date().toISOString());
    await saveStore(store);
    log(summaryLine(evaluations));
    log("");
    log(`superseded ${period.label}: the old root stays in the chain, marked superseded.`);
    log(`sealed:   ${dir}`);
    log(`root:     ${signed.root}`);
    await refreshInstrumentationLock({
      cwd,
      crosswalks: selected,
      evaluations,
      period: period.label,
      log,
    });
    return 0;
  }

  if (plan.gaps.length > 0) {
    recordGaps(
      store,
      plan.gaps,
      "never sealed inside the retention window; this evidence cannot be produced now",
    );
    log(`GAP: ${plan.gaps.join(", ")} ${plan.gaps.length === 1 ? "was" : "were"} never sealed.`);
    log("Recorded as explicit gaps in the chain. An auditor will see them; hiding a");
    log("hole would discredit the periods that are sealed.");
    log("");
  }
  if (plan.backfill) {
    log(`Note: ${period.label} is earlier than an already-sealed period. It will be`);
    log("chained in seal order, and the record says so.");
    log("");
  }

  const unsigned = buildBundle({
    batch,
    evaluations,
    subject,
    previous_root: plan.previous,
    period,
  });
  const { signed, attestation } = await signAndAttest(opts, unsigned, log);
  const dir = opts.out ?? bundleDir(store, period.label);
  await writeAll(signed, attestation, dir);
  recordSeal(store, period, signed.root, dir, new Date().toISOString(), {
    backfill: plan.backfill,
  });
  await saveStore(store);

  log(summaryLine(evaluations));
  log("");
  log(`period:   ${period.label} (${period.from} → ${period.to})`);
  log(`sealed:   ${dir}`);
  log(`root:     ${signed.root}`);
  log(`previous: ${plan.previous ?? "none (first link)"}`);
  log(`chain:    proof chain`);
  await refreshInstrumentationLock({
    cwd,
    crosswalks: selected,
    evaluations,
    period: period.label,
    log,
  });
  return 0;
}

/* ------------------------------------------------------------------ */
/* Ad-hoc mode: one-off bundle over everything, outside the period     */
/* chain. The adoption path; must never regress.                       */
/* ------------------------------------------------------------------ */

interface LegacyChainEntry {
  root: string;
  dir: string;
  period: { from: string; to: string } | null;
}

async function sealAdhoc(opts: SealOptions, paths: string[]): Promise<number> {
  const { cwd, log } = opts;

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

  const chainPath = join(cwd, ".proofbook", "chain.json");
  let chain: LegacyChainEntry[] = [];
  try {
    chain = JSON.parse(await readFile(chainPath, "utf8")) as LegacyChainEntry[];
  } catch {
    /* first seal */
  }
  const previous = opts.previous ?? chain.at(-1)?.root ?? null;

  const unsigned = buildBundle({
    batch: result.batch,
    evaluations: result.evaluations,
    subject: opts.subject ?? defaultSubject(cwd),
    previous_root: previous,
  });
  const { signed, attestation } = await signAndAttest(opts, unsigned, log);

  const period = (unsigned.manifest as { period: { from: string; to: string } | null }).period;
  const dirName =
    opts.out ??
    join(
      cwd,
      period ? `bundle-${period.from.slice(0, 10)}--${period.to.slice(0, 10)}` : "bundle-empty",
    );
  await writeAll(signed, attestation, dirName);

  chain.push({ root: signed.root, dir: dirName, period });
  await mkdir(join(cwd, ".proofbook"), { recursive: true });
  await writeFile(chainPath, JSON.stringify(chain, null, 2));

  log(summaryLine(result.evaluations));
  log("");
  log(`sealed:   ${dirName}  (ad-hoc: outside the period chain; use --period to join it)`);
  log(`root:     ${signed.root}`);
  log(`previous: ${previous ?? "none (first link)"}`);
  log(`verify:   proof verify ${dirName}`);
  return 0;
}
