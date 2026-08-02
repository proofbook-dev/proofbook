import * as ed from "@noble/ed25519";
import { canonicalize, merkleRoot, sha256Hex } from "./canonical.js";

/**
 * Offline bundle verification.
 *
 * Implements docs/bundle-spec.md exactly; a third party can (and is
 * expected to) reimplement it from that document without this code.
 * Nothing here trusts anything beyond sha256 and ed25519: no network,
 * no clock, no Proofbook service.
 *
 * Every check reports individually so a failure names precisely what
 * was tampered with, rather than a bare "invalid".
 */

export interface VerifyCheck {
  id: string;
  ok: boolean;
  detail: string;
}

export interface VerifyResult {
  ok: boolean;
  root?: string;
  checks: VerifyCheck[];
}

/** Files that are not covered by the manifest digest list, by design:
 * they either ARE the manifest, or they reference the root (and so
 * cannot be referenced BY it). Each is verified by its own check. */
const UNCOVERED = new Set([
  "manifest.json",
  "signature",
  "provenance/local.json",
  "provenance/attestation.intoto.json",
  "provenance/sigstore.json",
]);

export function verifyBundleFiles(files: Map<string, string>): VerifyResult {
  const checks: VerifyCheck[] = [];
  const push = (id: string, ok: boolean, detail: string) => checks.push({ id, ok, detail });

  // 1. Manifest parses and is in canonical form.
  const manifestText = files.get("manifest.json");
  if (manifestText === undefined) {
    push("manifest", false, "manifest.json is missing");
    return { ok: false, checks };
  }
  let manifest: Record<string, unknown>;
  try {
    manifest = JSON.parse(manifestText) as Record<string, unknown>;
  } catch {
    push("manifest", false, "manifest.json is not valid JSON");
    return { ok: false, checks };
  }
  if (canonicalize(manifest) !== manifestText) {
    push("manifest", false, "manifest.json is not in canonical form; bytes were altered");
  } else {
    push("manifest", true, "manifest parses and is canonical");
  }

  // 2. Every file the manifest names exists and matches its digest.
  const declared = (manifest.files ?? {}) as Record<string, string>;
  let filesOk = true;
  for (const [path, expected] of Object.entries(declared)) {
    const content = files.get(path);
    if (content === undefined) {
      filesOk = false;
      push("file_digest", false, `${path}: named in manifest but missing from bundle`);
      continue;
    }
    const actual = sha256Hex(content);
    if (actual !== expected) {
      filesOk = false;
      push("file_digest", false, `${path}: content digest mismatch (tampered or corrupted)`);
    }
  }
  if (filesOk) push("file_digest", true, `${Object.keys(declared).length} content file(s) match their digests`);

  // 3. No content files outside the manifest.
  const unexpected = [...files.keys()].filter((p) => !UNCOVERED.has(p) && declared[p] === undefined);
  push(
    "no_unexpected_files",
    unexpected.length === 0,
    unexpected.length === 0
      ? "no files outside the manifest"
      : `file(s) present but not covered by the manifest: ${unexpected.join(", ")}`,
  );

  // 4. The event merkle tree is internally consistent.
  const merkleText = files.get("evidence/events.merkle");
  if (merkleText !== undefined) {
    try {
      const tree = JSON.parse(merkleText) as { root: string; leaves: string[]; leaf_count: number };
      const recomputed = merkleRoot(tree.leaves);
      const countOk = tree.leaves.length === tree.leaf_count;
      push(
        "events_merkle",
        recomputed === tree.root && countOk,
        recomputed === tree.root && countOk
          ? `merkle root consistent over ${tree.leaf_count} event digest(s)`
          : "merkle root does not match its leaves (tampered event digests)",
      );
    } catch {
      push("events_merkle", false, "evidence/events.merkle is not valid JSON");
    }
  }

  // 5. Root and signature.
  const root = sha256Hex(manifestText);
  push("root", true, `root ${root}`);

  const signature = files.get("signature");
  const provenanceText = files.get("provenance/local.json");
  if (signature === undefined || provenanceText === undefined) {
    push("signature", false, "signature or provenance/local.json missing");
  } else {
    try {
      const provenance = JSON.parse(provenanceText) as { public_key: string };
      const valid = ed.verify(
        ed.etc.hexToBytes(signature.trim()),
        ed.etc.hexToBytes(root),
        ed.etc.hexToBytes(provenance.public_key),
      );
      push(
        "signature",
        valid,
        valid
          ? `ed25519 signature valid for key ${provenance.public_key.slice(0, 16)}…`
          : "signature does not verify against the root and the recorded public key",
      );
    } catch {
      push("signature", false, "signature or public key is malformed");
    }
  }

  // 6. Chain link shape (continuity across bundles is the store's job).
  const previous = manifest.previous;
  push(
    "chain_link",
    previous === null || (typeof previous === "string" && /^[0-9a-f]{64}$/.test(previous)),
    previous === null
      ? "first link: no previous bundle"
      : typeof previous === "string" && /^[0-9a-f]{64}$/.test(previous)
        ? `links to previous root ${String(previous).slice(0, 16)}…`
        : "previous root is malformed",
  );

  return { ok: checks.every((c) => c.ok), root, checks };
}
