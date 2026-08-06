import { deleteEvidence, listEvidence, PushError, type EvidenceSet } from "@proofbook/store";
import type { Log } from "../log.js";
import { formatEvidenceSets } from "./list.js";

/**
 * `proof delete`: remove a subject's whole evidence set from the hosted
 * chain (bundles, sign-offs, archives, orphaned share links). Destructive
 * and irreversible on the server, so it refuses to run without --yes and
 * touches nothing locally.
 *
 * You rarely know the exact subject string, so the target is resolved
 * against `proof list`: a root prefix, an exact subject, a unique subject
 * prefix, or the only set if there is just one. Anything ambiguous stops
 * and prints the candidates rather than guessing.
 */

export interface DeleteCmdOptions {
  /** Explicit --subject (name or unique prefix); never the config default. */
  subject: string | undefined;
  /** A root prefix (positional arg or --root), as shown by `proof list`. */
  ref: string | undefined;
  url?: string | undefined;
  token?: string | undefined;
  yes: boolean;
  log: Log;
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

function resolveTarget(
  sets: EvidenceSet[],
  subject: string | undefined,
  ref: string | undefined,
): { target: EvidenceSet | undefined; candidates: EvidenceSet[]; needle: string } {
  if (ref) {
    const candidates = sets.filter((s) => s.latest_root.startsWith(ref.toLowerCase()));
    return { target: candidates.length === 1 ? candidates[0] : undefined, candidates, needle: ref };
  }
  if (subject) {
    const exact = sets.filter((s) => s.subject === subject);
    let candidates = exact.length ? exact : sets.filter((s) => s.subject.startsWith(subject));
    if (candidates.length === 0) candidates = sets.filter((s) => s.subject.includes(subject));
    return { target: candidates.length === 1 ? candidates[0] : undefined, candidates, needle: subject };
  }
  if (sets.length === 1) return { target: sets[0], candidates: sets, needle: "" };
  return { target: undefined, candidates: sets, needle: "" };
}

export async function deleteCommand(opts: DeleteCmdOptions): Promise<number> {
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
    log("No evidence sets on the hosted chain; nothing to delete.");
    return 0;
  }

  const { target, candidates, needle } = resolveTarget(sets, opts.subject, opts.ref);
  if (!target) {
    if (!opts.subject && !opts.ref) {
      log("Several evidence sets exist. Pick one by root prefix or --subject:");
    } else if (candidates.length === 0) {
      log(`Nothing matches "${needle}". Evidence sets on the hosted chain:`);
    } else {
      log(`"${needle}" matches ${candidates.length} evidence sets:`);
    }
    log("");
    for (const line of formatEvidenceSets(candidates.length ? candidates : sets)) log(line);
    log("");
    log("Then:  proof delete <root-prefix> --yes   (or --subject <name>)");
    return 1;
  }

  const subject = target.subject;
  if (!opts.yes) {
    log(`This permanently deletes the hosted evidence set "${subject}"`);
    log(`  (${plural(target.live, "period")}, root ${target.latest_root.slice(0, 12)}…):`);
    log("  every sealed period and re-seal, declared sign-offs, encrypted archives,");
    log("  and any share link left covering nothing. It cannot be undone.");
    log("  Local bundles, traces and keys are untouched.");
    log("");
    log(`Re-run to confirm:  proof delete --subject ${subject} --yes`);
    return 1;
  }

  try {
    const r = await deleteEvidence(subject, { url: opts.url, token: opts.token });
    log(`Deleted "${r.subject}" from the hosted chain:`);
    log(
      `  ${plural(r.bundles, "bundle")}, ${plural(r.attestations, "sign-off")}, ` +
        `${plural(r.archives, "archive")}, ${plural(r.shares, "share link")}.`,
    );
    log("Local bundles and traces were not touched.");
    return 0;
  } catch (err) {
    if (err instanceof PushError) {
      log(err.message);
      return 1;
    }
    throw err;
  }
}
