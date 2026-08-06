import { deleteEvidence, PushError } from "@proofbook/store";
import type { Log } from "../log.js";

/**
 * `proof delete`: remove a subject's whole evidence set from the hosted
 * chain (bundles, sign-offs, archives, orphaned share links). Destructive
 * and irreversible on the server, so it refuses to run without --yes and
 * touches nothing locally. The subject comes from config unless overridden.
 */

export interface DeleteCmdOptions {
  subject: string | undefined;
  url?: string | undefined;
  token?: string | undefined;
  yes: boolean;
  log: Log;
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

export async function deleteCommand(opts: DeleteCmdOptions): Promise<number> {
  const { subject, log } = opts;
  if (!subject) {
    log("No subject to delete. Pass --subject <name>, or set one in .proofbook/config.json.");
    return 1;
  }
  if (!opts.yes) {
    log(`This permanently deletes the hosted evidence set for "${subject}":`);
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
