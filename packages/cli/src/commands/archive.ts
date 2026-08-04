import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  eventLeafHash,
  extractFromArchive,
  generateArchiveKey,
  parseArchiveKey,
  readArchiveHeader,
  readBundleDir,
  sha256Hex,
  type ExtractQuery,
} from "@proofbook/seal";
import type { Log } from "../log.js";

/**
 * `proof archive`: the encrypted event archive, owner side.
 *
 *   keygen              mint the 32-byte key; Proofbook never sees it
 *   info <file.pba>     header summary, no key needed
 *   verify <file.pba> --bundle <dir>   digest against the sealed manifest
 *   extract <file.pba> --trace <id[:span]>[,...]   decrypt only what's asked
 *
 * Extraction answers the auditor's spot-check years after the trace
 * vendor deleted the spans: produce the cited event, show its leaf in
 * the bundle's sealed merkle tree, done.
 */

export interface ArchiveOptions {
  cwd: string;
  sub: string | undefined;
  file: string | undefined;
  key?: string | undefined;
  trace?: string | undefined;
  bundle?: string | undefined;
  out?: string | undefined;
  log: Log;
}

const USAGE = [
  "Usage:",
  "  proof archive keygen                          write .proofbook/archive.key",
  "  proof archive info <file.pba>",
  "  proof archive verify <file.pba> --bundle <bundle-dir>",
  "  proof archive extract <file.pba> --trace <trace_id[:span_id]>[,...]",
  "                 [--key <keyfile>] [--bundle <bundle-dir>] [--out <file>]",
].join("\n");

async function loadArchiveKey(cwd: string, keyPath: string | undefined, log: Log) {
  const path = keyPath ?? join(cwd, ".proofbook", "archive.key");
  try {
    return parseArchiveKey(await readFile(path, "utf8"));
  } catch {
    log(`No usable archive key at ${path}. Generate one: proof archive keygen`);
    return null;
  }
}

export async function archiveCommand(opts: ArchiveOptions): Promise<number> {
  const { cwd, log } = opts;

  switch (opts.sub) {
    case "keygen": {
      const path = opts.key ?? join(cwd, ".proofbook", "archive.key");
      try {
        await readFile(path, "utf8");
        log(`${path} already exists; refusing to overwrite a key that may guard sealed archives.`);
        return 1;
      } catch {
        /* absent: proceed */
      }
      await mkdir(join(cwd, ".proofbook"), { recursive: true });
      await writeFile(path, `${generateArchiveKey()}\n`, { mode: 0o600 });
      log(`Archive key written to ${path} (mode 600). Keep it out of version control.`);
      log("Everything sealed with it is unreadable without it, to Proofbook included.");
      log("Losing this key means losing every archive it sealed: store it like a");
      log("signing secret, and copy it somewhere your CI secrets live.");
      return 0;
    }

    case "info": {
      if (!opts.file) return usage(log);
      const { header } = readArchiveHeader(await readFile(opts.file));
      log(`archive:     ${opts.file}`);
      log(`events:      ${header.event_count.toLocaleString("en-US")}`);
      log(`chunks:      ${header.chunks.length}`);
      log(`cipher:      ${header.cipher} over ${header.compression}`);
      log(`key id:      ${header.key_id}`);
      log(`created at:  ${header.created_at}`);
      return 0;
    }

    case "verify": {
      if (!opts.file || !opts.bundle) return usage(log);
      const bytes = await readFile(opts.file);
      const files = await readBundleDir(opts.bundle);
      const manifest = JSON.parse(files.get("manifest.json")!) as {
        archive?: { digest: string; events: number };
      };
      if (!manifest.archive) {
        log("This bundle was sealed without an archive; nothing to verify against.");
        return 2;
      }
      const digest = sha256Hex(bytes);
      if (digest !== manifest.archive.digest) {
        log(`✕ MISMATCH`);
        log(`  sealed digest:  ${manifest.archive.digest}`);
        log(`  this file:      ${digest}`);
        log("This is not the archive that was sealed with the bundle, or it was altered.");
        return 2;
      }
      log(`✓ archive matches the sealed manifest (${manifest.archive.events.toLocaleString("en-US")} events, digest ${digest.slice(0, 16)}…)`);
      return 0;
    }

    case "extract": {
      if (!opts.file || !opts.trace) return usage(log);
      const key = await loadArchiveKey(cwd, opts.key, log);
      if (!key) return 1;
      const queries: ExtractQuery[] = opts.trace.split(",").map((spec) => {
        const [trace_id, span_id] = spec.trim().split(":");
        return { trace_id: trace_id!, span_id: span_id || undefined };
      });
      const bytes = await readFile(opts.file);
      const { matches, chunks_read, chunks_total } = extractFromArchive(bytes, key, queries);

      let leaves: Set<string> | null = null;
      if (opts.bundle) {
        const files = await readBundleDir(opts.bundle);
        const merkle = JSON.parse(files.get("evidence/events.merkle")!) as { leaves: string[] };
        leaves = new Set(merkle.leaves);
      }

      const results = matches.map((m) => ({
        ...m,
        ...(leaves
          ? { sealed: leaves.has(eventLeafHash(m)) ? ("leaf verified in bundle merkle" as const) : ("NOT in bundle merkle" as const) }
          : {}),
      }));

      const output = JSON.stringify(results, null, 2);
      if (opts.out) {
        await writeFile(opts.out, output);
        log(`${matches.length} event${matches.length === 1 ? "" : "s"} → ${opts.out}`);
      } else {
        log(output);
      }
      log("");
      log(
        `${matches.length} match${matches.length === 1 ? "" : "es"} · decrypted ${chunks_read} of ${chunks_total} chunks`,
      );
      if (leaves && results.some((r) => "sealed" in r && r.sealed === "NOT in bundle merkle")) {
        log("⚠ some events did not verify against the bundle's sealed merkle tree.");
        return 2;
      }
      return matches.length > 0 ? 0 : 3;
    }

    default:
      return usage(log);
  }
}

function usage(log: Log): number {
  log(USAGE);
  return 1;
}
