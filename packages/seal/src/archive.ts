import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { brotliCompressSync, brotliDecompressSync, constants as zc } from "node:zlib";
import type { NormalizedBatch } from "@proofbook/schema";
import { canonicalize, sha256Hex } from "./canonical.js";

/**
 * The encrypted event archive (.pba, "PBA1").
 *
 * The sealed bundle cites spans by trace_id/span_id; vendors delete the
 * spans themselves within weeks. The archive keeps the cited material
 * producible for the bundle's whole lifetime: every normalized event,
 * sorted, chunked, brotli-compressed and encrypted with a key only the
 * producing organisation holds. Proofbook never sees the key; the
 * portal stores ciphertext it cannot open.
 *
 * Layout: "PBA1" · u32 header length · header JSON (plaintext) ·
 * ciphertext chunks concatenated. The header carries per-chunk IVs,
 * ciphertext digests and first/last sort keys, so a lookup decrypts
 * only the chunks whose key range matches, never the whole archive.
 * Events are normalized records: content appears as sha256 digests
 * only, so even the plaintext never contains a prompt.
 *
 * Verification needs no key: sha256 of the whole file is recorded in
 * the sealed manifest. Inclusion needs no trust: an extracted event
 * re-hashes to a leaf of the bundle's evidence/events.merkle.
 */

const MAGIC = "PBA1";
const CHUNK_EVENTS = 5000;

export interface ArchiveChunkMeta {
  iv: string;
  bytes: number;
  events: number;
  digest_enc: string;
  first: string;
  last: string;
}

export interface ArchiveHeader {
  magic: typeof MAGIC;
  version: 1;
  cipher: "aes-256-gcm";
  compression: "brotli";
  key_id: string;
  event_count: number;
  created_at: string;
  chunks: ArchiveChunkMeta[];
}

export interface ArchiveSummary {
  digest: string;
  bytes: number;
  events: number;
  key_id: string;
  cipher: "aes-256-gcm+brotli";
}

interface ArchivedEvent {
  type: string;
  event: Record<string, unknown>;
}

/** Short fingerprint so a wrong key fails fast and legibly. */
export function keyId(key: Buffer): string {
  return createHash("sha256").update(key).digest("hex").slice(0, 16);
}

export function generateArchiveKey(): string {
  return randomBytes(32).toString("base64");
}

export function parseArchiveKey(text: string): Buffer {
  const key = Buffer.from(text.trim(), "base64");
  if (key.length !== 32) {
    throw new Error("archive key must be 32 bytes of base64 (proof archive keygen writes one)");
  }
  return key;
}

function sortKeyOf(event: Record<string, unknown>): string {
  const source = event.source as { trace_id?: string; span_id?: string } | undefined;
  if (source?.trace_id) return `${source.trace_id}:${source.span_id ?? ""}`;
  const trace = (event.trace_id as string) ?? "";
  const span = (event.span_id as string) ?? "";
  return trace ? `${trace}:${span}` : `~:${span}`;
}

function flatten(batch: NormalizedBatch): { key: string; entry: ArchivedEvent }[] {
  const rows: { key: string; entry: ArchivedEvent }[] = [];
  const events = batch.events as unknown as Record<string, Array<Record<string, unknown>>>;
  for (const type of Object.keys(events).sort()) {
    for (const event of events[type]!) {
      rows.push({ key: sortKeyOf(event), entry: { type, event } });
    }
  }
  rows.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  return rows;
}

function compressEncrypt(plain: Buffer, key: Buffer): { iv: Buffer; ciphertext: Buffer } {
  const packed = brotliCompressSync(plain, {
    params: { [zc.BROTLI_PARAM_QUALITY]: 10, [zc.BROTLI_PARAM_SIZE_HINT]: plain.length },
  });
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const body = Buffer.concat([cipher.update(packed), cipher.final(), cipher.getAuthTag()]);
  return { iv, ciphertext: body };
}

function decryptDecompress(ciphertext: Buffer, key: Buffer, iv: Buffer): Buffer {
  const tag = ciphertext.subarray(ciphertext.length - 16);
  const body = ciphertext.subarray(0, ciphertext.length - 16);
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  const packed = Buffer.concat([decipher.update(body), decipher.final()]);
  return brotliDecompressSync(packed);
}

export function buildArchive(batch: NormalizedBatch, key: Buffer): { bytes: Buffer; summary: ArchiveSummary } {
  const rows = flatten(batch);
  const chunkMetas: ArchiveChunkMeta[] = [];
  const chunkBodies: Buffer[] = [];

  for (let start = 0; start < rows.length; start += CHUNK_EVENTS) {
    const slice = rows.slice(start, start + CHUNK_EVENTS);
    const plain = Buffer.from(slice.map((r) => canonicalize(r.entry)).join("\n"), "utf8");
    const { iv, ciphertext } = compressEncrypt(plain, key);
    chunkMetas.push({
      iv: iv.toString("base64"),
      bytes: ciphertext.length,
      events: slice.length,
      digest_enc: createHash("sha256").update(ciphertext).digest("hex"),
      first: slice[0]!.key,
      last: slice.at(-1)!.key,
    });
    chunkBodies.push(ciphertext);
  }

  const header: ArchiveHeader = {
    magic: MAGIC,
    version: 1,
    cipher: "aes-256-gcm",
    compression: "brotli",
    key_id: keyId(key),
    event_count: rows.length,
    created_at: new Date().toISOString(),
    chunks: chunkMetas,
  };
  const headerBytes = Buffer.from(JSON.stringify(header), "utf8");
  const lengthPrefix = Buffer.alloc(4);
  lengthPrefix.writeUInt32BE(headerBytes.length);
  const bytes = Buffer.concat([Buffer.from(MAGIC, "ascii"), lengthPrefix, headerBytes, ...chunkBodies]);

  return {
    bytes,
    summary: {
      digest: createHash("sha256").update(bytes).digest("hex"),
      bytes: bytes.length,
      events: rows.length,
      key_id: header.key_id,
      cipher: "aes-256-gcm+brotli",
    },
  };
}

export function readArchiveHeader(bytes: Buffer): { header: ArchiveHeader; bodyOffset: number } {
  if (bytes.subarray(0, 4).toString("ascii") !== MAGIC) {
    throw new Error("not a Proofbook archive (missing PBA1 magic)");
  }
  const headerLength = bytes.readUInt32BE(4);
  const header = JSON.parse(bytes.subarray(8, 8 + headerLength).toString("utf8")) as ArchiveHeader;
  return { header, bodyOffset: 8 + headerLength };
}

export interface ExtractQuery {
  trace_id: string;
  span_id?: string | undefined;
}

/**
 * Extract events matching the queries, decrypting only the chunks
 * whose sorted key range can contain them.
 */
export function extractFromArchive(
  bytes: Buffer,
  key: Buffer,
  queries: ExtractQuery[],
): { matches: ArchivedEvent[]; chunks_read: number; chunks_total: number } {
  const { header, bodyOffset } = readArchiveHeader(bytes);
  if (header.key_id !== keyId(key)) {
    throw new Error(
      `wrong key: archive was encrypted with key ${header.key_id}, this key is ${keyId(key)}`,
    );
  }

  const wanted = queries.map((q) => ({
    prefix: q.span_id ? `${q.trace_id}:${q.span_id}` : `${q.trace_id}:`,
    exact: Boolean(q.span_id),
  }));

  const offsets: number[] = [];
  let cursor = bodyOffset;
  for (const chunk of header.chunks) {
    offsets.push(cursor);
    cursor += chunk.bytes;
  }

  const matches: ArchivedEvent[] = [];
  let read = 0;
  header.chunks.forEach((chunk, i) => {
    const relevant = wanted.some((w) => {
      const probe = w.prefix;
      // A chunk can contain the key iff first <= probe-range and last >= probe.
      return chunk.last >= probe && chunk.first <= `${probe}￿`;
    });
    if (!relevant) return;
    read += 1;
    const ciphertext = bytes.subarray(offsets[i]!, offsets[i]! + chunk.bytes);
    if (createHash("sha256").update(ciphertext).digest("hex") !== chunk.digest_enc) {
      throw new Error(`chunk ${i} has been altered since sealing`);
    }
    const lines = decryptDecompress(ciphertext, key, Buffer.from(chunk.iv, "base64")).toString("utf8");
    for (const line of lines.split("\n")) {
      if (!line) continue;
      const entry = JSON.parse(line) as ArchivedEvent;
      const entryKey = sortKeyOf(entry.event);
      if (wanted.some((w) => (w.exact ? entryKey === w.prefix : entryKey.startsWith(w.prefix)))) {
        matches.push(entry);
      }
    }
  });

  return { matches, chunks_read: read, chunks_total: header.chunks.length };
}

/** Leaf hash exactly as evidence/events.merkle computes it. */
export function eventLeafHash(entry: ArchivedEvent): string {
  return sha256Hex(`${entry.type}\n${canonicalize(entry.event)}`);
}
