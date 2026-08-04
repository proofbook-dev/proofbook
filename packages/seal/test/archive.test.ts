import { describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { normalizeOtlpFiles } from "@proofbook/normalize";
import {
  buildArchive,
  eventLeafHash,
  extractFromArchive,
  generateArchiveKey,
  keyId,
  parseArchiveKey,
  readArchiveHeader,
  buildBundle,
} from "../src/index.js";
import { loadCrosswalkDir } from "@proofbook/crosswalk";
import { evaluateFramework } from "@proofbook/engine";

const fixtures = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "fixtures", "traces");
const basic = join(fixtures, "otel-genai-basic.json");

const key = parseArchiveKey(generateArchiveKey());

describe("encrypted event archive", () => {
  it("round-trips: build, header without key, extract by trace with the key", async () => {
    const batch = await normalizeOtlpFiles([basic]);
    const { bytes, summary } = buildArchive(batch, key);

    expect(summary.events).toBeGreaterThan(0);
    expect(summary.key_id).toBe(keyId(key));

    // Header is readable without any key and leaks structure only.
    const { header } = readArchiveHeader(bytes);
    expect(header.event_count).toBe(summary.events);
    expect(JSON.stringify(header)).not.toContain("gen_ai");

    // Pick a real event's coordinates and extract exactly it.
    const anyList = Object.values(batch.events).find((l) => l.length > 0)!;
    const target = anyList[0] as { trace_id: string; span_id: string };
    const { matches, chunks_read, chunks_total } = extractFromArchive(bytes, key, [
      { trace_id: target.trace_id, span_id: target.span_id },
    ]);
    expect(matches.length).toBeGreaterThan(0);
    expect(chunks_read).toBeLessThanOrEqual(chunks_total);
    expect((matches[0]!.event as { trace_id: string }).trace_id).toBe(target.trace_id);
  });

  it("extracted events verify as leaves of the sealed bundle's merkle tree", async () => {
    const batch = await normalizeOtlpFiles([basic]);
    const { bytes, summary } = buildArchive(batch, key);
    const frameworks = await loadCrosswalkDir();
    const bundle = buildBundle({
      batch,
      evaluations: [evaluateFramework(batch, frameworks.get("eu-ai-act")!)],
      subject: "acme",
      archive: summary,
    });
    expect((bundle.manifest as { archive: { digest: string } }).archive.digest).toBe(summary.digest);

    const merkle = JSON.parse(bundle.files.get("evidence/events.merkle")!) as { leaves: string[] };
    const anyList = Object.values(batch.events).find((l) => l.length > 0)!;
    const target = anyList[0] as { trace_id: string; span_id: string };
    const { matches } = extractFromArchive(bytes, key, [{ trace_id: target.trace_id }]);
    for (const m of matches) {
      expect(merkle.leaves).toContain(eventLeafHash(m));
    }
  });

  it("refuses the wrong key by fingerprint, and detects tampering", async () => {
    const batch = await normalizeOtlpFiles([basic]);
    const { bytes } = buildArchive(batch, key);
    const otherKey = parseArchiveKey(generateArchiveKey());
    expect(() => extractFromArchive(bytes, otherKey, [{ trace_id: "x" }])).toThrow(/wrong key/);

    const tampered = Buffer.from(bytes);
    tampered[tampered.length - 5] = tampered[tampered.length - 5]! ^ 0xff;
    const anyList = Object.values(batch.events).find((l) => l.length > 0)!;
    const target = anyList[0] as { trace_id: string };
    expect(() =>
      extractFromArchive(tampered, key, [{ trace_id: target.trace_id }]),
    ).toThrow(/altered/);
  });
});
