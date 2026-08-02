import { createHash } from "node:crypto";

/**
 * Canonical JSON: recursively sorted object keys, no whitespace.
 * Every hash in a bundle is computed over this form, and manifest.json
 * is written in this form, so "same content" and "same bytes" are the
 * same statement. A subset of RFC 8785, sufficient because bundle
 * content is plain JSON data produced by this codebase (no floats with
 * exotic representations, no lone surrogates).
 */
export function canonicalize(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : 1));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalize(v)}`).join(",")}}`;
}

export function sha256Hex(text: string | Uint8Array): string {
  return createHash("sha256").update(text).digest("hex");
}

/**
 * Merkle root over already-hashed leaves (hex strings). Pairwise
 * sha256(left || right) on the hex strings; an odd node is promoted
 * unchanged. Empty input has the defined root sha256("").
 */
export function merkleRoot(leaves: string[]): string {
  if (leaves.length === 0) return sha256Hex("");
  let level = leaves;
  while (level.length > 1) {
    const next: string[] = [];
    for (let i = 0; i < level.length; i += 2) {
      next.push(i + 1 < level.length ? sha256Hex(level[i]! + level[i + 1]!) : level[i]!);
    }
    level = next;
  }
  return level[0]!;
}
