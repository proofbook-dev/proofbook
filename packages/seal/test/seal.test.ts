import { describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { normalizeOtlpFiles } from "@proofbook/normalize";
import { loadCrosswalkDir } from "@proofbook/crosswalk";
import { evaluateFramework } from "@proofbook/engine";
import {
  buildBundle,
  generateKeypair,
  readBundleDir,
  signBundle,
  verifyBundleFiles,
  writeBundle,
  type SignedBundle,
} from "../src/index.js";

const fixtures = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "fixtures", "traces");
const basic = join(fixtures, "otel-genai-basic.json");

async function makeBundle(previous_root: string | null = null) {
  const batch = await normalizeOtlpFiles([basic]);
  const frameworks = await loadCrosswalkDir();
  const evaluations = [evaluateFramework(batch, frameworks.get("eu-ai-act")!)];
  return buildBundle({ batch, evaluations, subject: "acme-claims/agent-runtime", previous_root });
}

async function writtenFiles(bundle: SignedBundle): Promise<Map<string, string>> {
  const dir = await mkdtemp(join(tmpdir(), "proofbook-bundle-"));
  try {
    await writeBundle(bundle, dir);
    return await readBundleDir(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe("seal: building and signing", () => {
  it("produces a deterministic root: same input, same bytes", async () => {
    const a = await makeBundle();
    const b = await makeBundle();
    expect(a.root).toBe(b.root);
    expect([...a.files.entries()]).toEqual([...b.files.entries()]);
    // ...while signatures may differ (fresh keys), the signed content cannot.
  });

  it("contains the architecture's tree and pins the crosswalk", async () => {
    const bundle = await makeBundle();
    const paths = [...bundle.files.keys()];
    expect(paths).toContain("coverage.json");
    expect(paths).toContain("evidence/events.merkle");
    expect(paths).toContain("evidence/samples.json");
    expect(paths.some((p) => p.startsWith("controls/eu-ai-act/"))).toBe(true);

    const manifest = bundle.manifest as { crosswalks: Array<{ pin: string }>; previous: unknown };
    expect(manifest.crosswalks[0]!.pin).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(manifest.previous).toBeNull();
  });

  it("chains: the next bundle records the previous root", async () => {
    const first = await makeBundle();
    const second = await makeBundle(first.root);
    expect((second.manifest as { previous: string }).previous).toBe(first.root);
    expect(second.root).not.toBe(first.root);
  });

  it("never contains payload content", async () => {
    const bundle = await makeBundle();
    const everything = [...bundle.files.values()].join("");
    expect(everything).not.toContain("Triage this claim");
    expect(everything).not.toContain("adjuster pool");
    expect(everything).not.toContain("m.keane@acme.example");
  });
});

describe("verify: the offline check", () => {
  it("passes a genuine signed bundle on every check", async () => {
    const keys = generateKeypair();
    const signed = signBundle(await makeBundle(), keys.private_key, {
      created_at: "2026-08-02T12:00:00.000Z",
    });
    const files = await writtenFiles(signed);

    const result = verifyBundleFiles(files);
    expect(result.ok).toBe(true);
    expect(result.root).toBe(signed.root);
    expect(result.checks.every((c) => c.ok)).toBe(true);
  });

  it("names the tampered file when content is altered", async () => {
    const keys = generateKeypair();
    const files = await writtenFiles(signBundle(await makeBundle(), keys.private_key));

    files.set("coverage.json", files.get("coverage.json")!.replace('"spans_seen":6', '"spans_seen":600'));
    const result = verifyBundleFiles(files);
    expect(result.ok).toBe(false);
    const failure = result.checks.find((c) => !c.ok)!;
    expect(failure.id).toBe("file_digest");
    expect(failure.detail).toContain("coverage.json");
  });

  it("catches a tampered verdict in a control file", async () => {
    const keys = generateKeypair();
    const files = await writtenFiles(signBundle(await makeBundle(), keys.private_key));

    const path = "controls/eu-ai-act/eu-ai-act-a12-input.json";
    files.set(path, files.get(path)!.replace('"not_evidenced"', '"evidenced"'));
    const result = verifyBundleFiles(files);
    expect(result.ok).toBe(false);
    expect(result.checks.find((c) => !c.ok)!.detail).toContain(path);
  });

  it("catches a rewritten manifest, even internally consistent, via the signature", async () => {
    const keys = generateKeypair();
    const files = await writtenFiles(signBundle(await makeBundle(), keys.private_key));

    // Attacker rewrites the manifest (canonically!) and fixes the digest
    // of a file they also modified. Everything is consistent except the
    // signature over the new root.
    const manifest = JSON.parse(files.get("manifest.json")!) as {
      files: Record<string, string>;
      subject: string;
    };
    manifest.subject = "someone-else-entirely";
    const { canonicalize } = await import("../src/canonical.js");
    files.set("manifest.json", canonicalize(manifest));

    const result = verifyBundleFiles(files);
    expect(result.ok).toBe(false);
    expect(result.checks.find((c) => c.id === "signature")!.ok).toBe(false);
  });

  it("catches tampered merkle leaves and files smuggled outside the manifest", async () => {
    const keys = generateKeypair();
    const files = await writtenFiles(signBundle(await makeBundle(), keys.private_key));

    const tree = JSON.parse(files.get("evidence/events.merkle")!) as { leaves: string[] };
    tree.leaves[0] = tree.leaves[0]!.replace(/^./, tree.leaves[0]![0] === "a" ? "b" : "a");
    const { canonicalize } = await import("../src/canonical.js");
    files.set("evidence/events.merkle", canonicalize(tree));
    files.set("extra/note.json", "{}");

    const result = verifyBundleFiles(files);
    expect(result.ok).toBe(false);
    const ids = result.checks.filter((c) => !c.ok).map((c) => c.id);
    expect(ids).toContain("file_digest"); // merkle file digest broke
    expect(ids).toContain("no_unexpected_files");
  });

  it("rejects a signature from the wrong key", async () => {
    const bundle = await makeBundle();
    const rightKeys = generateKeypair();
    const wrongKeys = generateKeypair();
    const signed = signBundle(bundle, rightKeys.private_key);
    const files = await writtenFiles(signed);

    // Swap in an impostor signature made with another key.
    const impostor = signBundle(bundle, wrongKeys.private_key);
    files.set("signature", impostor.signature);

    const result = verifyBundleFiles(files);
    expect(result.ok).toBe(false);
    expect(result.checks.find((c) => c.id === "signature")!.ok).toBe(false);
  });
});
