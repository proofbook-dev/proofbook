import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import * as ed from "@noble/ed25519";
import { sha512 } from "@noble/hashes/sha512";
import type { FrameworkEvaluation, NormalizedBatch } from "@proofbook/schema";
import { canonicalize, merkleRoot, sha256Hex } from "./canonical.js";

// @noble/ed25519 v2 needs a sha512 implementation wired in for the sync API.
ed.etc.sha512Sync = (...msgs) => sha512(ed.etc.concatBytes(...msgs));

/**
 * The sealed evidence bundle.
 *
 * On disk it is the tree the architecture doc describes:
 *
 *   manifest.json            all file digests, pins, chain link - canonical JSON
 *   coverage.json            counts, completeness, detections, unmapped, conflicts
 *   controls/<fw>/<id>.json  one ControlResult per control, derivations included
 *   evidence/events.merkle   merkle tree over per-event digests
 *   evidence/samples.json    metadata-only event samples
 *   provenance/local.json    signing mode, public key, optional wall-clock time
 *   signature                detached ed25519 signature over the root
 *
 * The root is sha256 of manifest.json's bytes; the manifest contains
 * the digest of every content file, so any byte changed anywhere
 * changes the root, and the tampered file is nameable. Timestamps and
 * signatures live outside the root on purpose: same traces + same
 * crosswalk must reproduce the same root, or idempotent monthly
 * sealing (and the hash chain built on it) cannot work.
 */

export const BUNDLE_FORMAT_VERSION = "0.1.0";

const SAMPLES_PER_TYPE = 5;
/**
 * Above this, evidence/events.merkle carries the root and count but
 * not the leaf list: at millions of events the leaves alone would be
 * hundreds of megabytes of bundle. The root stays committed, and every
 * leaf is recomputable from the encrypted archive by its owner.
 */
const LEAF_INLINE_MAX = 20_000;

export interface BundleInput {
  batch: NormalizedBatch;
  evaluations: FrameworkEvaluation[];
  subject: string;
  /** Root hash of the previous period's bundle; null for the first link. */
  previous_root?: string | null;
  normalizer_version?: string;
  /**
   * The declared period this bundle covers. When set, the manifest
   * records the declared window rather than the observed event range:
   * "no events in June" and "June was never evaluated" must not look
   * the same.
   */
  period?: { label?: string; from: string; to: string };
  /**
   * Summary of the encrypted event archive sealed alongside this
   * bundle. Recording digest and key fingerprint here makes the
   * archive tamper-evident and bundle-bound without the bundle ever
   * containing, or Proofbook ever seeing, a decryptable byte.
   */
  archive?: {
    digest: string;
    bytes: number;
    events: number;
    key_id: string;
    cipher: string;
  } | null;
}

export interface UnsignedBundle {
  /** Content files, path → canonical JSON bytes (as string). */
  files: Map<string, string>;
  manifest: Record<string, unknown>;
  /** sha256 of manifest.json bytes. The chain links on this. */
  root: string;
}

export interface SignedBundle extends UnsignedBundle {
  signature: string;
  public_key: string;
  created_at?: string | undefined;
}

function periodOf(batch: NormalizedBatch): { from: string; to: string } | null {
  const times: string[] = [];
  for (const list of Object.values(batch.events)) {
    for (const e of list as Array<Record<string, unknown>>) {
      for (const key of ["started_at", "ended_at", "at"]) {
        if (typeof e[key] === "string") times.push(e[key] as string);
      }
    }
  }
  times.sort();
  return times.length > 0 ? { from: times[0]!, to: times.at(-1)! } : null;
}

function eventLeaves(batch: NormalizedBatch): string[] {
  const leaves: string[] = [];
  for (const key of Object.keys(batch.events).sort()) {
    for (const event of batch.events[key as keyof typeof batch.events]) {
      leaves.push(sha256Hex(`${key}\n${canonicalize(event)}`));
    }
  }
  return leaves;
}

function samples(batch: NormalizedBatch): Record<string, unknown[]> {
  const out: Record<string, unknown[]> = {};
  for (const key of Object.keys(batch.events).sort()) {
    const list = batch.events[key as keyof typeof batch.events] as unknown[];
    if (list.length > 0) out[key] = list.slice(0, SAMPLES_PER_TYPE);
  }
  return out;
}

export function buildBundle(input: BundleInput): UnsignedBundle {
  const { batch, evaluations, subject } = input;
  const files = new Map<string, string>();

  files.set(
    "coverage.json",
    canonicalize({
      counts: batch.counts,
      completeness: batch.completeness,
      detections: batch.detections,
      conflicts: batch.conflicts,
      unmapped: batch.unmapped,
      missing_fields: batch.missing_fields,
      source: batch.source,
    }),
  );

  for (const ev of evaluations) {
    for (const control of ev.controls) {
      files.set(`controls/${ev.framework}/${control.control_id}.json`, canonicalize(control));
    }
  }

  const leaves = eventLeaves(batch);
  files.set(
    "evidence/events.merkle",
    canonicalize({
      algorithm: "sha256-merkle-v1",
      leaf: "sha256(event_type + '\\n' + canonical(event))",
      leaf_count: leaves.length,
      root: merkleRoot(leaves),
      ...(leaves.length <= LEAF_INLINE_MAX
        ? { leaves }
        : { leaves_inlined: false, note: "leaf list omitted at this scale; recomputable from the encrypted event archive" }),
    }),
  );
  files.set("evidence/samples.json", canonicalize(samples(batch)));

  const manifest = {
    bundle_format_version: BUNDLE_FORMAT_VERSION,
    subject,
    period: input.period ?? periodOf(batch),
    event_schema_version: batch.schema_version,
    normalizer_version: input.normalizer_version ?? "0.1.0",
    content_ref_hashing: "sha256-unsalted",
    crosswalks: evaluations.map((ev) => ({
      framework: ev.framework,
      framework_version: ev.framework_version,
      crosswalk_version: ev.crosswalk_version,
      pin: ev.crosswalk_pin,
    })),
    summaries: evaluations.map((ev) => ({ framework: ev.framework, ...ev.summary })),
    previous: input.previous_root ?? null,
    // Only present when an archive was sealed: absent keys keep the
    // roots of archiveless bundles identical across tool versions.
    ...(input.archive ? { archive: input.archive } : {}),
    files: Object.fromEntries(
      [...files.entries()]
        .sort(([a], [b]) => (a < b ? -1 : 1))
        .map(([path, content]) => [path, sha256Hex(content)]),
    ),
  };

  const manifestBytes = canonicalize(manifest);
  return { files, manifest, root: sha256Hex(manifestBytes) };
}

export function generateKeypair(): { private_key: string; public_key: string } {
  const priv = ed.utils.randomPrivateKey();
  return {
    private_key: ed.etc.bytesToHex(priv),
    public_key: ed.etc.bytesToHex(ed.getPublicKey(priv)),
  };
}

export function signBundle(
  bundle: UnsignedBundle,
  privateKeyHex: string,
  opts: { created_at?: string } = {},
): SignedBundle {
  const priv = ed.etc.hexToBytes(privateKeyHex);
  const publicKey = ed.etc.bytesToHex(ed.getPublicKey(priv));
  const signature = ed.etc.bytesToHex(ed.sign(ed.etc.hexToBytes(bundle.root), priv));
  return {
    ...bundle,
    signature,
    public_key: publicKey,
    ...(opts.created_at !== undefined ? { created_at: opts.created_at } : {}),
  };
}

export async function writeBundle(bundle: SignedBundle, dir: string): Promise<void> {
  const all = new Map(bundle.files);
  all.set("manifest.json", canonicalize(bundle.manifest));
  all.set(
    "provenance/local.json",
    canonicalize({
      mode: "local-ed25519",
      public_key: bundle.public_key,
      ...(bundle.created_at ? { created_at: bundle.created_at } : {}),
      note:
        "Locally signed: proves integrity against this key only. CI-bound OIDC signing " +
        "(provenance package) carries stronger identity and a transparency log entry.",
    }),
  );
  all.set("signature", bundle.signature);

  for (const [path, content] of all) {
    const full = join(dir, path);
    await mkdir(dirname(full), { recursive: true });
    await writeFile(full, content, "utf8");
  }
}

export async function readBundleDir(dir: string): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  async function walk(rel: string): Promise<void> {
    for (const entry of await readdir(join(dir, rel), { withFileTypes: true })) {
      const relPath = rel === "" ? entry.name : `${rel}/${entry.name}`;
      if (entry.isDirectory()) await walk(relPath);
      else out.set(relPath, await readFile(join(dir, relPath), "utf8"));
    }
  }
  await walk("");
  return out;
}
