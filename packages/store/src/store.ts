import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { readBundleDir, verifyBundleFiles } from "@proofbook/seal";
import { isMonthLabel, monthsBetween, type Period } from "./period.js";

/**
 * The local evidence store: bundles plus the chain ledger.
 *
 * Three invariants, enforced here because an auditor reading a
 * continuous chain will assume continuity:
 *
 * 1. One live bundle per period. Re-sealing an identical period is a
 *    no-op; re-sealing a divergent one is refused unless explicitly
 *    superseding, and supersession is itself recorded.
 * 2. No silent gaps. A month that was never sealed gets an explicit
 *    gap entry the moment a later month is sealed past it.
 * 3. The chain links in seal order. A backfilled period sits out of
 *    calendar order in the chain; the record says so rather than
 *    pretending otherwise.
 */

export const ChainEntry = z.object({
  kind: z.enum(["sealed", "gap"]),
  label: z.string(),
  from: z.string(),
  to: z.string(),
  /** sealed entries only */
  root: z.string().optional(),
  dir: z.string().optional(),
  sealed_at: z.string().optional(),
  superseded_by: z.string().optional(),
  note: z.string().optional(),
});
export type ChainEntry = z.infer<typeof ChainEntry>;

const ChainFile = z.object({
  version: z.literal(1),
  entries: z.array(ChainEntry),
});
export type ChainFile = z.infer<typeof ChainFile>;

export interface Store {
  dir: string;
  chain: ChainFile;
}

export class StoreError extends Error {}

export async function openStore(dir: string): Promise<Store> {
  try {
    const chain = ChainFile.parse(JSON.parse(await readFile(join(dir, "chain.json"), "utf8")));
    return { dir, chain };
  } catch {
    return { dir, chain: { version: 1, entries: [] } };
  }
}

export async function saveStore(store: Store): Promise<void> {
  await mkdir(store.dir, { recursive: true });
  await writeFile(join(store.dir, "chain.json"), JSON.stringify(store.chain, null, 2));
}

export function bundleDir(store: Store, label: string, generation = 0): string {
  return join(store.dir, "bundles", generation === 0 ? label : `${label}@${generation + 1}`);
}

/** Live (non-superseded) sealed entries, in seal order. */
export function liveSealed(store: Store): ChainEntry[] {
  return store.chain.entries.filter((e) => e.kind === "sealed" && e.superseded_by === undefined);
}

export function headRoot(store: Store): string | null {
  return liveSealed(store).at(-1)?.root ?? null;
}

export interface SealPlan {
  kind: "new" | "duplicate";
  /** For duplicates: the existing live entry. */
  existing?: ChainEntry;
  /** Month labels that must be recorded as gaps before this seal. */
  gaps: string[];
  /** The previous root the new bundle must reference. */
  previous: string | null;
  /** True when this period is earlier than an already-sealed one. */
  backfill: boolean;
}

export function planSeal(store: Store, period: Period): SealPlan {
  const live = liveSealed(store);
  const existing = live.find((e) => e.label === period.label);
  if (existing) {
    return { kind: "duplicate", existing, gaps: [], previous: existing.root ?? null, backfill: false };
  }

  let gaps: string[] = [];
  let backfill = false;
  if (isMonthLabel(period.label)) {
    const knownMonths = store.chain.entries
      .filter((e) => isMonthLabel(e.label))
      .map((e) => e.label);
    const latest = knownMonths.filter((l) => l < period.label).sort().at(-1);
    if (latest !== undefined) {
      gaps = monthsBetween(latest, period.label).filter((l) => !knownMonths.includes(l));
    }
    backfill = knownMonths.some((l) => l > period.label);
  }

  return { kind: "new", gaps, previous: headRoot(store), backfill };
}

export function recordGaps(store: Store, labels: string[], note: string): void {
  for (const label of labels) {
    const [y, m] = label.split("-").map(Number) as [number, number];
    store.chain.entries.push({
      kind: "gap",
      label,
      from: new Date(Date.UTC(y, m - 1, 1)).toISOString(),
      to: new Date(Date.UTC(y, m, 1)).toISOString(),
      note,
    });
  }
}

export function recordSeal(
  store: Store,
  period: Period,
  root: string,
  dir: string,
  sealedAt: string,
  opts: { backfill?: boolean } = {},
): void {
  store.chain.entries.push({
    kind: "sealed",
    label: period.label,
    from: period.from,
    to: period.to,
    root,
    dir,
    sealed_at: sealedAt,
    ...(opts.backfill
      ? { note: "backfilled: sealed after a later period; chain order differs from calendar order" }
      : {}),
  });
}

/** Mark the live entry for a label as superseded by a new root. */
export function recordSupersession(store: Store, label: string, newRoot: string): void {
  const entry = liveSealed(store).find((e) => e.label === label);
  if (!entry) throw new StoreError(`no live sealed entry for ${label} to supersede`);
  entry.superseded_by = newRoot;
  entry.note = (entry.note ? entry.note + "; " : "") + "superseded";
}

export interface ChainProblem {
  label: string;
  problem: string;
}

export interface ChainReport {
  ok: boolean;
  sealed: number;
  gaps: ChainEntry[];
  superseded: number;
  problems: ChainProblem[];
}

/**
 * Walk the whole chain: every live bundle verifies structurally, and
 * every bundle's `previous` matches the root of the live bundle sealed
 * before it. A break here is the loudest thing the store can report.
 */
export async function verifyChain(store: Store): Promise<ChainReport> {
  const problems: ChainProblem[] = [];
  const live = liveSealed(store);

  let previous: string | null = null;
  for (const entry of live) {
    if (!entry.root || !entry.dir) {
      problems.push({ label: entry.label, problem: "sealed entry missing root or dir" });
      continue;
    }
    let files;
    try {
      files = await readBundleDir(entry.dir);
    } catch {
      problems.push({ label: entry.label, problem: `bundle directory missing: ${entry.dir}` });
      previous = entry.root;
      continue;
    }
    const result = verifyBundleFiles(files);
    if (!result.ok) {
      const failed = result.checks.filter((c) => !c.ok).map((c) => c.id).join(", ");
      problems.push({ label: entry.label, problem: `bundle fails verification (${failed})` });
    }
    if (result.root !== entry.root) {
      problems.push({ label: entry.label, problem: "bundle root does not match the chain ledger" });
    }
    const manifest = JSON.parse(files.get("manifest.json") ?? "{}") as { previous?: string | null };
    if ((manifest.previous ?? null) !== previous) {
      problems.push({
        label: entry.label,
        problem: `chain link broken: bundle references ${manifest.previous ?? "null"}, expected ${previous ?? "null"}`,
      });
    }
    previous = entry.root;
  }

  return {
    ok: problems.length === 0,
    sealed: live.length,
    gaps: store.chain.entries.filter((e) => e.kind === "gap"),
    superseded: store.chain.entries.filter((e) => e.superseded_by !== undefined).length,
    problems,
  };
}
