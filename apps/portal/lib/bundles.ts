import { monthsBetween } from "@proofbook/store";

/**
 * Reading pushed bundles back into portal shapes. Everything here works
 * on the stored `files` map (path → content string), which is exactly
 * what the CLI pushed and exactly what a recipient downloads: the
 * portal renders the same bytes it hands out for independent
 * verification, never a second copy that could drift.
 */

export interface StoredBundle {
  id: string;
  org_id: string;
  root: string;
  previous_root: string | null;
  subject: string;
  period_label: string | null;
  period_from: string | null;
  period_to: string | null;
  frameworks: string[];
  summaries: FrameworkSummary[];
  verification: { ok: boolean; checks: { id: string; ok: boolean; detail: string }[] };
  verification_ok: boolean;
  provenance_mode: string;
  files: Record<string, string>;
  superseded_by: string | null;
  received_at: string;
}

export interface FrameworkSummary {
  framework: string;
  evidenced: number;
  partially_evidenced: number;
  not_evidenced: number;
  contradicted: number;
  unevaluable: number;
}

export interface ControlRecord {
  framework: string;
  control_id: string;
  article?: string;
  title: string;
  requirement_summary: string;
  verdict: string;
  assertions: {
    assertion_id: string;
    description: string;
    source_class: "observed" | "configured" | "declared";
    verdict: string;
    derivation: Record<string, unknown>;
    evidence?: Record<string, unknown>;
    unevaluable_reason?: string;
  }[];
}

export const VERDICTS = [
  "evidenced",
  "partially_evidenced",
  "not_evidenced",
  "contradicted",
  "unevaluable",
] as const;

export function controlsOf(bundle: StoredBundle): ControlRecord[] {
  const controls: ControlRecord[] = [];
  for (const [path, content] of Object.entries(bundle.files)) {
    const m = path.match(/^controls\/([^/]+)\/(.+)\.json$/);
    if (!m) continue;
    controls.push({ framework: m[1]!, ...(JSON.parse(content) as Omit<ControlRecord, "framework">) });
  }
  return controls.sort((a, b) => (a.control_id < b.control_id ? -1 : 1));
}

export function coverageOf(bundle: StoredBundle): Record<string, unknown> | null {
  const text = bundle.files["coverage.json"];
  return text ? (JSON.parse(text) as Record<string, unknown>) : null;
}

export function totalCounts(summaries: FrameworkSummary[]): FrameworkSummary {
  const total = {
    framework: "all",
    evidenced: 0,
    partially_evidenced: 0,
    not_evidenced: 0,
    contradicted: 0,
    unevaluable: 0,
  };
  for (const s of summaries) {
    total.evidenced += s.evidenced;
    total.partially_evidenced += s.partially_evidenced;
    total.not_evidenced += s.not_evidenced;
    total.contradicted += s.contradicted;
    total.unevaluable += s.unevaluable;
  }
  return total;
}

export type ChainEntry =
  | { kind: "bundle"; bundle: StoredBundle }
  | { kind: "gap"; labels: string[] };

/**
 * Assemble the display chain in period order, rendering every missing
 * month between sealed monthly periods as an explicit gap entry. A
 * silent hole in an evidence timeline is the one thing this screen
 * exists to prevent.
 */
export function assembleChain(bundles: StoredBundle[]): ChainEntry[] {
  const live = bundles
    .filter((b) => !b.superseded_by)
    .sort((a, b) => (a.period_from ?? a.received_at) < (b.period_from ?? b.received_at) ? -1 : 1);

  const entries: ChainEntry[] = [];
  let previous: StoredBundle | null = null;
  for (const bundle of live) {
    if (previous?.period_label && bundle.period_label) {
      try {
        const missing = monthsBetween(previous.period_label, bundle.period_label);
        if (missing.length > 0) entries.push({ kind: "gap", labels: missing });
      } catch {
        /* non-month labels: no gap inference possible */
      }
    }
    entries.push({ kind: "bundle", bundle });
    previous = bundle;
  }
  return entries;
}

/** Per-control verdict changes between two consecutive bundles. */
export function verdictDeltas(
  prev: StoredBundle,
  next: StoredBundle,
): { control_id: string; title: string; from: string; to: string }[] {
  const before = new Map(controlsOf(prev).map((c) => [c.control_id, c]));
  const deltas: { control_id: string; title: string; from: string; to: string }[] = [];
  for (const control of controlsOf(next)) {
    const was = before.get(control.control_id);
    if (was && was.verdict !== control.verdict) {
      deltas.push({
        control_id: control.control_id,
        title: control.title,
        from: was.verdict,
        to: control.verdict,
      });
    }
  }
  return deltas;
}
