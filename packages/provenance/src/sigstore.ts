import type { SigstoreSignFn } from "./attest.js";

/**
 * The Sigstore boundary. The `sigstore` package is loaded dynamically
 * and is never a dependency of the core path: airgapped runs must work,
 * and keyless signing only makes sense where an OIDC identity exists.
 */

export async function loadSigstoreSigner(): Promise<SigstoreSignFn> {
  let mod: { attest: (payload: Buffer, payloadType: string) => Promise<object> };
  try {
    // Non-literal specifier: resolved at runtime only. `sigstore` is
    // intentionally not a compile-time dependency of anything.
    const specifier = "sigstore";
    mod = (await import(specifier)) as typeof mod;
  } catch {
    throw new Error(
      "Keyless signing needs the `sigstore` package: add it to the workflow " +
        "(npm i sigstore) or use local signing. The core path never requires it.",
    );
  }
  return (payload, payloadType) => mod.attest(payload, payloadType);
}

/** The identity policy a verifier hands to sigstore's verify(). */
export function buildIdentityPolicy(expectedRepository: string): {
  certificateIssuer: string;
  subjectAlternativeNamePattern: string;
} {
  return {
    certificateIssuer: "https://token.actions.githubusercontent.com",
    subjectAlternativeNamePattern: `https://github.com/${expectedRepository}/.github/workflows/*`,
  };
}
