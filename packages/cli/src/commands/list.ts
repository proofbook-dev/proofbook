import { listEvidence, PushError, type EvidenceSet } from "@proofbook/store";
import type { Log } from "../log.js";

/**
 * `proof list`: the evidence sets on the hosted chain, grouped by subject,
 * with the exact name and a root prefix to hand to `proof delete`. Read-only.
 */

export interface ListCmdOptions {
  url?: string | undefined;
  token?: string | undefined;
  log: Log;
}

/** A fixed-width table of evidence sets, reused by `list` and `delete`. */
export function formatEvidenceSets(sets: EvidenceSet[]): string[] {
  const rows = sets.map((s) => ({
    subject: s.subject,
    bundles: String(s.live) + (s.bundles !== s.live ? ` (+${s.bundles - s.live})` : ""),
    period: s.latest_period ?? "-",
    root: s.latest_root.slice(0, 12),
  }));
  const w = {
    subject: Math.max(7, ...rows.map((r) => r.subject.length)),
    bundles: Math.max(7, ...rows.map((r) => r.bundles.length)),
    period: Math.max(6, ...rows.map((r) => r.period.length)),
  };
  const pad = (s: string, n: number) => s.padEnd(n);
  const head = `  ${pad("SUBJECT", w.subject)}  ${pad("BUNDLES", w.bundles)}  ${pad("LATEST", w.period)}  ROOT`;
  const body = rows.map(
    (r) => `  ${pad(r.subject, w.subject)}  ${pad(r.bundles, w.bundles)}  ${pad(r.period, w.period)}  ${r.root}…`,
  );
  return [head, ...body];
}

export async function listCommand(opts: ListCmdOptions): Promise<number> {
  const { log } = opts;
  let sets: EvidenceSet[];
  try {
    sets = await listEvidence({ url: opts.url, token: opts.token });
  } catch (err) {
    if (err instanceof PushError) {
      log(err.message);
      return 1;
    }
    throw err;
  }
  if (sets.length === 0) {
    log("No evidence sets on the hosted chain. Push a sealed bundle first: proof push.");
    return 0;
  }
  log(`Hosted evidence sets (${sets.length}):`);
  log("");
  for (const line of formatEvidenceSets(sets)) log(line);
  log("");
  log("BUNDLES counts live periods; (+n) is superseded re-seals kept on record.");
  log("Delete one:  proof delete <root-prefix> --yes   (or --subject <name>)");
  return 0;
}
