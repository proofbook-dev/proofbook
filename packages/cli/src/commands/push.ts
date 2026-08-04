import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { readBundleDir } from "@proofbook/seal";
import { liveSealed, openStore, pushArchive, pushBundle, PushError } from "@proofbook/store";
import type { Log } from "../log.js";

/**
 * `proof push [bundle-dir]`: send a sealed bundle (and only the bundle)
 * to the hosted evidence chain. Defaults to the newest sealed period.
 */
export interface PushCmdOptions {
  cwd: string;
  dir?: string | undefined;
  url?: string | undefined;
  token?: string | undefined;
  log: Log;
  fetchImpl?: typeof fetch | undefined;
}

export async function pushCommand(opts: PushCmdOptions): Promise<number> {
  const { log } = opts;

  let dir = opts.dir;
  let label = "bundle";
  if (!dir) {
    const store = await openStore(join(opts.cwd, ".proofbook", "store"));
    const head = liveSealed(store).at(-1);
    if (!head?.dir) {
      log("Nothing to push: the period chain is empty. Seal first: proof seal --period last-month");
      return 1;
    }
    dir = head.dir;
    label = head.label;
  }

  let files;
  try {
    files = await readBundleDir(dir);
  } catch {
    log(`Cannot read a bundle at ${dir}.`);
    return 1;
  }
  const manifest = files.get("manifest.json");
  if (!manifest) {
    log(`${dir} has no manifest.json; not a bundle.`);
    return 1;
  }
  const { sha256Hex } = await import("@proofbook/seal");
  const root = sha256Hex(manifest);

  const size = [...files.values()].reduce((n, c) => n + c.length, 0);
  try {
    const result = await pushBundle(files, root, {
      url: opts.url,
      token: opts.token,
      fetchImpl: opts.fetchImpl,
    });
    log(`pushed ${label} (${(size / 1_000_000).toFixed(1)} MB, ${files.size} files) · root ${result.root.slice(0, 16)}…`);
    log("Only the bundle crossed: verdicts, digests, signatures. No traces, no content.");

    // A bundle sealed with --archive references its ciphertext; ship it
    // too when the file is here. The portal stores what it cannot read.
    const manifestMeta = JSON.parse(manifest) as {
      archive?: { digest: string; key_id: string; bytes: number };
    };
    if (manifestMeta.archive) {
      const archivePath = join(opts.cwd, ".proofbook", "store", "archives", `${root}.pba`);
      try {
        const bytes = await readFile(archivePath);
        await pushArchive(bytes, { root, key_id: manifestMeta.archive.key_id, digest: manifestMeta.archive.digest }, {
          url: opts.url,
          token: opts.token,
          fetchImpl: opts.fetchImpl,
        });
        log(`archive pushed (${(bytes.length / 1_000_000).toFixed(1)} MB, encrypted with key ${manifestMeta.archive.key_id}).`);
        log("Proofbook stores the ciphertext and cannot open it; extraction needs your key.");
      } catch (err) {
        if (err instanceof PushError) log(`archive: ${err.message}`);
        else log(`archive: not pushed (${(err as Error).message}); the bundle push succeeded.`);
      }
    }
    return 0;
  } catch (err) {
    if (err instanceof PushError) {
      log(err.message);
      return 1;
    }
    throw err;
  }
}
