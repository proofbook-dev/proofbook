import { describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { normalizeOtlpFiles } from "@proofbook/normalize";
import { loadCrosswalkDir } from "@proofbook/crosswalk";
import { evaluateFramework } from "@proofbook/engine";
import {
  buildBundle,
  canonicalize,
  generateKeypair,
  signBundle,
  verifyBundleFiles,
  type SignedBundle,
} from "@proofbook/seal";
import {
  buildAttestationFiles,
  buildStatement,
  decodeJwtClaims,
  getGitHubIdentity,
  IN_TOTO_PAYLOAD_TYPE,
  signEnvelope,
  statementBytes,
  verifyAttestation,
  verifyEnvelope,
  type CIIdentity,
  type Envelope,
} from "../src/index.js";

const fixtures = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "fixtures", "traces");
const basic = join(fixtures, "otel-genai-basic.json");
const partial = join(fixtures, "otel-genai-partial.json");

const CI: CIIdentity = {
  provider: "github",
  issuer: "https://token.actions.githubusercontent.com",
  repository: "acme-claims/agent-runtime",
  workflow_ref: "acme-claims/agent-runtime/.github/workflows/evidence.yml@refs/heads/main",
  sha: "9d41f2e0c4a6b81b2c3d4e5f60718293",
  run_id: "48291022",
  run_attempt: "1",
};

async function makeBundle(paths: string[] = [basic]) {
  const batch = await normalizeOtlpFiles(paths);
  const frameworks = await loadCrosswalkDir();
  const evaluations = [evaluateFramework(batch, frameworks.get("eu-ai-act")!)];
  return buildBundle({ batch, evaluations, subject: "acme-claims/agent-runtime" });
}

/** All files as they would exist on disk. */
function materialize(signed: SignedBundle, attestation: Map<string, string>): Map<string, string> {
  const files = new Map(signed.files);
  files.set("manifest.json", canonicalize(signed.manifest));
  files.set(
    "provenance/local.json",
    canonicalize({ mode: "local-ed25519", public_key: signed.public_key }),
  );
  files.set("signature", signed.signature);
  for (const [path, content] of attestation) files.set(path, content);
  return files;
}

describe("OIDC identity", () => {
  it("decodes claims from the runner's token", async () => {
    const claims = {
      iss: "https://token.actions.githubusercontent.com",
      repository: "acme-claims/agent-runtime",
      job_workflow_ref: "acme-claims/agent-runtime/.github/workflows/evidence.yml@refs/heads/main",
      sha: "abc123",
      run_id: "42",
      run_attempt: "2",
    };
    const jwt = `eyJh.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.sig`;
    expect(decodeJwtClaims(jwt).repository).toBe("acme-claims/agent-runtime");

    const identity = await getGitHubIdentity(
      {
        ACTIONS_ID_TOKEN_REQUEST_URL: "https://runner.local/token?x=1",
        ACTIONS_ID_TOKEN_REQUEST_TOKEN: "req-token",
      },
      async (url, init) => {
        expect(url).toContain("audience=sigstore");
        expect(init.headers.authorization).toBe("Bearer req-token");
        return { ok: true, json: async () => ({ value: jwt }) };
      },
    );
    expect(identity).toMatchObject({ repository: "acme-claims/agent-runtime", run_attempt: "2" });
  });

  it("returns null outside CI and fails loudly when the permission is missing", async () => {
    expect(await getGitHubIdentity({})).toBeNull();
    await expect(
      getGitHubIdentity(
        { ACTIONS_ID_TOKEN_REQUEST_URL: "https://x", ACTIONS_ID_TOKEN_REQUEST_TOKEN: "t" },
        async () => ({ ok: false, json: async () => ({}) }),
      ),
    ).rejects.toThrow("id-token: write");
  });
});

describe("statement and envelope", () => {
  it("binds the statement subject to the bundle root and records the builder", async () => {
    const bundle = await makeBundle();
    const statement = buildStatement({ bundle, identity: CI });
    expect(statement.subject[0]).toEqual({
      name: "acme-claims/agent-runtime",
      digest: { sha256: bundle.root },
    });
    expect(statement.predicate.builder).toMatchObject({
      mode: "github-oidc",
      repository: "acme-claims/agent-runtime",
      run_id: "48291022",
    });
    // Local mode says what it is.
    const local = buildStatement({ bundle, identity: null });
    expect(JSON.stringify(local.predicate.builder)).toContain("binds content to a key");
  });

  it("DSSE: signatures cover the payload type, not just the bytes", async () => {
    const keys = generateKeypair();
    const payload = new TextEncoder().encode('{"hello":"world"}');
    const envelope = signEnvelope(payload, IN_TOTO_PAYLOAD_TYPE, keys.private_key);

    expect(verifyEnvelope(envelope, keys.public_key).valid).toBe(true);

    // Same bytes, different type: the signature must not transfer.
    const retyped: Envelope = { ...envelope, payloadType: "application/vnd.other+json" };
    expect(verifyEnvelope(retyped, keys.public_key).valid).toBe(false);

    const wrongKey = generateKeypair();
    expect(verifyEnvelope(envelope, wrongKey.public_key).valid).toBe(false);
  });
});

describe("forge attempts", () => {
  it("a genuine attested bundle passes everything, including expectations", async () => {
    const bundle = await makeBundle();
    const keys = generateKeypair();
    const signed = signBundle(bundle, keys.private_key);
    const attestation = await buildAttestationFiles({
      bundle,
      identity: CI,
      privateKeyHex: keys.private_key,
    });
    const files = materialize(signed, attestation);

    expect(verifyBundleFiles(files).ok).toBe(true);
    const checks = verifyAttestation(files, {
      expected_public_key: keys.public_key,
      expected_repository: "acme-claims/agent-runtime",
    });
    expect(checks.every((c) => c.ok)).toBe(true);
  });

  it("forge 1: attacker re-seals altered content with their own key - caught by key expectation", async () => {
    const victim = generateKeypair();
    const attacker = generateKeypair();

    // Attacker builds a different (flattering) bundle and signs/attests
    // it entirely with their own key, claiming the victim's subject.
    const flattering = await makeBundle([basic]);
    const signed = signBundle(flattering, attacker.private_key);
    const attestation = await buildAttestationFiles({
      bundle: flattering,
      identity: CI, // lies about where it was built
      privateKeyHex: attacker.private_key,
    });
    const files = materialize(signed, attestation);

    // Internally consistent - that is the point of the attack...
    expect(verifyBundleFiles(files).ok).toBe(true);
    // ...but the verifier expects the victim's key, and the lie collapses.
    const checks = verifyAttestation(files, { expected_public_key: victim.public_key });
    expect(checks.find((c) => c.id === "attestation_signature")!.ok).toBe(false);
  });

  it("forge 2: replaying a genuine attestation onto different content - subject mismatch", async () => {
    const keys = generateKeypair();
    const honest = await makeBundle([basic]);
    const honestAttestation = await buildAttestationFiles({
      bundle: honest,
      identity: CI,
      privateKeyHex: keys.private_key,
    });

    // Different evidence, same subject name - with the honest bundle's
    // attestation stapled on.
    const different = await makeBundle([basic, partial]);
    const signed = signBundle(different, keys.private_key);
    const files = materialize(signed, honestAttestation);

    const checks = verifyAttestation(files, { expected_public_key: keys.public_key });
    const subject = checks.find((c) => c.id === "attestation_subject")!;
    expect(subject.ok).toBe(false);
    expect(subject.detail).toContain("attests something else");
  });

  it("forge 3: editing the statement inside the envelope - signature breaks", async () => {
    const keys = generateKeypair();
    const bundle = await makeBundle();
    const signed = signBundle(bundle, keys.private_key);
    const attestation = await buildAttestationFiles({
      bundle,
      identity: null,
      privateKeyHex: keys.private_key,
    });
    const files = materialize(signed, attestation);

    // Rewrite the payload to claim a CI build.
    const envelope = JSON.parse(files.get("provenance/attestation.intoto.json")!) as Envelope;
    const statement = JSON.parse(Buffer.from(envelope.payload, "base64").toString("utf8"));
    statement.predicate.builder = { mode: "github-oidc", repository: "acme-claims/agent-runtime" };
    envelope.payload = Buffer.from(canonicalize(statement)).toString("base64");
    files.set("provenance/attestation.intoto.json", JSON.stringify(envelope));

    const checks = verifyAttestation(files, { expected_public_key: keys.public_key });
    expect(checks.find((c) => c.id === "attestation_signature")!.ok).toBe(false);
  });

  it("forge 4: a local attestation cannot impersonate a repository, and stripping is visible", async () => {
    const keys = generateKeypair();
    const bundle = await makeBundle();
    const signed = signBundle(bundle, keys.private_key);
    const attestation = await buildAttestationFiles({
      bundle,
      identity: null, // honest local build
      privateKeyHex: keys.private_key,
    });
    const files = materialize(signed, attestation);

    // Verifier requires a CI identity: local mode must not satisfy it.
    const checks = verifyAttestation(files, {
      expected_repository: "acme-claims/agent-runtime",
    });
    const identityCheck = checks.find((c) => c.id === "attestation_identity")!;
    expect(identityCheck.ok).toBe(false);
    expect(identityCheck.detail).toContain("bind to a key, not a repository");

    // Stripping the attestation entirely while expectations exist: caught.
    files.delete("provenance/attestation.intoto.json");
    const stripped = verifyAttestation(files, { expected_repository: "acme-claims/agent-runtime" });
    expect(stripped[0]!.ok).toBe(false);
  });
});

describe("sigstore plumbing", () => {
  it("hands the canonical statement to the injected signer and stores its bundle", async () => {
    const bundle = await makeBundle();
    let received: { payload: Buffer; type: string } | undefined;
    const files = await buildAttestationFiles({
      bundle,
      identity: CI,
      sigstoreSign: async (payload, payloadType) => {
        received = { payload, type: payloadType };
        return { fake: "sigstore-bundle" };
      },
    });

    expect(received!.type).toBe(IN_TOTO_PAYLOAD_TYPE);
    const statement = buildStatement({ bundle, identity: CI });
    expect(received!.payload.toString("utf8")).toBe(
      Buffer.from(statementBytes(statement)).toString("utf8"),
    );
    expect(JSON.parse(files.get("provenance/sigstore.json")!)).toEqual({ fake: "sigstore-bundle" });
  });
});
