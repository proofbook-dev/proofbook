import type { UnsignedBundle } from "@proofbook/seal";
import { IN_TOTO_PAYLOAD_TYPE, signEnvelope } from "./dsse.js";
import { buildStatement, statementBytes } from "./statement.js";
import type { CIIdentity } from "./identity.js";

/**
 * Produce the attestation files that ride alongside a bundle:
 *
 *   provenance/attestation.intoto.json   DSSE envelope over the statement
 *   provenance/sigstore.json             Sigstore bundle (cert + Rekor
 *                                        entry), keyless mode only
 *
 * Sigstore is injected, never imported at the top level: the core path
 * must work airgapped, and keyless signing is only possible where an
 * OIDC identity exists (CI). `sigstoreSign` is expected to be the
 * `sigstore` package's attest(), or a fake in tests.
 */

export type SigstoreSignFn = (
  payload: Buffer,
  payloadType: string,
) => Promise<object>;

export interface AttestOptions {
  bundle: UnsignedBundle;
  identity: CIIdentity | null;
  /** Local mode: the ed25519 key that also signed the bundle root. */
  privateKeyHex?: string;
  /** Keyless mode: sigstore attest function. */
  sigstoreSign?: SigstoreSignFn;
}

export async function buildAttestationFiles(opts: AttestOptions): Promise<Map<string, string>> {
  const statement = buildStatement({ bundle: opts.bundle, identity: opts.identity });
  const payload = statementBytes(statement);
  const files = new Map<string, string>();

  if (opts.sigstoreSign) {
    const sigstoreBundle = await opts.sigstoreSign(Buffer.from(payload), IN_TOTO_PAYLOAD_TYPE);
    files.set("provenance/sigstore.json", JSON.stringify(sigstoreBundle));
    // The DSSE envelope lives inside the sigstore bundle in keyless
    // mode; the statement is still written plainly for readability.
    files.set(
      "provenance/attestation.intoto.json",
      JSON.stringify({ payloadType: IN_TOTO_PAYLOAD_TYPE, statement }),
    );
    return files;
  }

  if (!opts.privateKeyHex) {
    throw new Error("attestation needs either a sigstore signer or a local private key");
  }
  const envelope = signEnvelope(payload, IN_TOTO_PAYLOAD_TYPE, opts.privateKeyHex);
  files.set("provenance/attestation.intoto.json", JSON.stringify(envelope));
  return files;
}
