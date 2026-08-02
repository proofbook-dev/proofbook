import { canonicalize, type UnsignedBundle } from "@proofbook/seal";
import type { CIIdentity } from "./identity.js";

/**
 * The in-toto statement: subject is the bundle root, predicate describes
 * how the evidence was produced. Modelled on SLSA build provenance
 * rather than a novel format, because auditors' tooling already
 * recognises the shape.
 */

export const STATEMENT_TYPE = "https://in-toto.io/Statement/v1";
export const PREDICATE_TYPE = "https://proofbook.dev/evidence/v0.1";

export interface Statement {
  _type: typeof STATEMENT_TYPE;
  subject: Array<{ name: string; digest: { sha256: string } }>;
  predicateType: typeof PREDICATE_TYPE;
  predicate: Record<string, unknown>;
}

export interface StatementInput {
  bundle: UnsignedBundle;
  identity: CIIdentity | null;
}

export function buildStatement({ bundle, identity }: StatementInput): Statement {
  const manifest = bundle.manifest as {
    subject: string;
    period: unknown;
    crosswalks: unknown;
    normalizer_version: unknown;
    event_schema_version: unknown;
    summaries: unknown;
    files: Record<string, string>;
    previous: unknown;
  };

  return {
    _type: STATEMENT_TYPE,
    subject: [{ name: manifest.subject, digest: { sha256: bundle.root } }],
    predicateType: PREDICATE_TYPE,
    predicate: {
      period: manifest.period,
      crosswalks: manifest.crosswalks,
      normalizer_version: manifest.normalizer_version,
      event_schema_version: manifest.event_schema_version,
      summaries: manifest.summaries,
      coverage_digest: manifest.files["coverage.json"],
      previous_root: manifest.previous,
      builder: identity
        ? {
            mode: "github-oidc",
            issuer: identity.issuer,
            repository: identity.repository,
            workflow_ref: identity.workflow_ref,
            sha: identity.sha,
            run_id: identity.run_id,
            run_attempt: identity.run_attempt,
          }
        : {
            mode: "local-ed25519",
            note: "No CI identity: this attestation binds content to a key, not to a repository.",
          },
    },
  };
}

export function statementBytes(statement: Statement): Uint8Array {
  return new Uint8Array(Buffer.from(canonicalize(statement), "utf8"));
}
