import { sha256Hex, type VerifyCheck } from "@proofbook/seal";
import { verifyEnvelope, type Envelope } from "./dsse.js";
import { PREDICATE_TYPE, STATEMENT_TYPE, type Statement } from "./statement.js";

/**
 * Attestation verification, layered on top of the seal package's
 * structural checks. Answers the questions a sceptical verifier
 * actually asks:
 *
 *   - Is this attestation signed, and by the key/identity it claims?
 *   - Does it attest THIS bundle (subject digest = recomputed root)?
 *   - Was it produced where the producer says it was produced?
 *
 * Expectations are the verifier's, not the bundle's: a bundle cannot
 * vouch for itself, so `expected_*` values come from the party
 * verifying (the buyer knows which repository they are assessing).
 */

export interface AttestationExpectations {
  expected_public_key?: string | undefined;
  expected_repository?: string | undefined;
}

export function verifyAttestation(
  files: Map<string, string>,
  expectations: AttestationExpectations = {},
): VerifyCheck[] {
  const checks: VerifyCheck[] = [];
  const push = (id: string, ok: boolean, detail: string) => checks.push({ id, ok, detail });

  const raw = files.get("provenance/attestation.intoto.json");
  if (raw === undefined) {
    const expecting =
      expectations.expected_public_key !== undefined ||
      expectations.expected_repository !== undefined;
    push(
      "attestation",
      !expecting,
      expecting
        ? "expectations were given but the bundle carries no attestation"
        : "no attestation present (sealed before the provenance package, or stripped)",
    );
    return checks;
  }

  const manifestText = files.get("manifest.json");
  if (manifestText === undefined) {
    push("attestation", false, "cannot bind attestation: manifest.json missing");
    return checks;
  }
  const root = sha256Hex(manifestText);

  let envelope: Envelope;
  try {
    envelope = JSON.parse(raw) as Envelope;
  } catch {
    push("attestation", false, "attestation.intoto.json is not valid JSON");
    return checks;
  }

  // Signature: against the expected key if given, else the local
  // provenance key, else the envelope's own keyid (existence only).
  let publicKey = expectations.expected_public_key;
  if (publicKey === undefined) {
    const local = files.get("provenance/local.json");
    if (local !== undefined) {
      try {
        publicKey = (JSON.parse(local) as { public_key?: string }).public_key;
      } catch {
        /* fall through */
      }
    }
  }
  publicKey = publicKey ?? envelope.signatures[0]?.keyid;

  if (publicKey === undefined) {
    push("attestation_signature", false, "no key available to verify the attestation envelope");
    return checks;
  }
  const { valid, payload } = verifyEnvelope(envelope, publicKey);
  push(
    "attestation_signature",
    valid,
    valid
      ? `envelope signature valid for key ${publicKey.slice(0, 16)}…`
      : `envelope signature invalid for key ${publicKey.slice(0, 16)}… (forged, re-signed, or wrong expected key)`,
  );
  if (!valid) return checks;

  let statement: Statement;
  try {
    statement = JSON.parse(Buffer.from(payload).toString("utf8")) as Statement;
  } catch {
    push("attestation_statement", false, "envelope payload is not a JSON statement");
    return checks;
  }
  const wellFormed =
    statement._type === STATEMENT_TYPE && statement.predicateType === PREDICATE_TYPE;
  push(
    "attestation_statement",
    wellFormed,
    wellFormed ? "in-toto statement well-formed" : "payload is not a Proofbook evidence statement",
  );

  const subjectDigest = statement.subject?.[0]?.digest?.sha256;
  const bound = subjectDigest === root;
  push(
    "attestation_subject",
    bound,
    bound
      ? `attestation binds this bundle (subject ${root.slice(0, 16)}…)`
      : "attestation subject does not match this bundle's root - it attests something else",
  );

  if (expectations.expected_repository !== undefined) {
    const builder = statement.predicate.builder as
      | { mode?: string; repository?: string }
      | undefined;
    const ok = builder?.mode === "github-oidc" && builder.repository === expectations.expected_repository;
    push(
      "attestation_identity",
      ok,
      ok
        ? `built in ${builder!.repository}`
        : builder?.mode === "github-oidc"
          ? `built in ${builder.repository ?? "unknown"}, expected ${expectations.expected_repository}`
          : `expected a CI-built attestation from ${expectations.expected_repository}, got mode "${builder?.mode ?? "unknown"}" - local attestations bind to a key, not a repository`,
    );
  }

  return checks;
}
