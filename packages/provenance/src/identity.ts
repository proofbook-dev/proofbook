/**
 * CI identity via OIDC.
 *
 * In GitHub Actions, the runner exposes ACTIONS_ID_TOKEN_REQUEST_URL and
 * ACTIONS_ID_TOKEN_REQUEST_TOKEN (when `permissions: id-token: write` is
 * set - the one line in the workflow that makes signing possible). The
 * token's claims bind repository, workflow ref, commit SHA, run id and
 * run attempt. Other providers (GitLab, generic OIDC) use the same shape
 * with different environment variables; they plug in here.
 */

export interface CIIdentity {
  provider: "github";
  issuer: string;
  repository: string;
  workflow_ref: string;
  sha: string;
  run_id: string;
  run_attempt: string;
}

/** Decode a JWT's claims without verifying it - verification is the
 * signing backend's job (Fulcio checks the token; we only read claims
 * to record and to bind the attestation). */
export function decodeJwtClaims(token: string): Record<string, unknown> {
  const parts = token.split(".");
  if (parts.length !== 3) throw new Error("not a JWT");
  return JSON.parse(Buffer.from(parts[1]!, "base64url").toString("utf8")) as Record<
    string,
    unknown
  >;
}

export type FetchLike = (
  url: string,
  init: { headers: Record<string, string> },
) => Promise<{ ok: boolean; json: () => Promise<unknown> }>;

export async function getGitHubIdentity(
  env: Record<string, string | undefined>,
  fetchImpl: FetchLike = fetch as unknown as FetchLike,
): Promise<CIIdentity | null> {
  const url = env.ACTIONS_ID_TOKEN_REQUEST_URL;
  const requestToken = env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
  if (!url || !requestToken) return null;

  const res = await fetchImpl(`${url}&audience=sigstore`, {
    headers: { authorization: `Bearer ${requestToken}` },
  });
  if (!res.ok) {
    throw new Error(
      "OIDC token request failed. Is `permissions: id-token: write` set on the job?",
    );
  }
  const { value } = (await res.json()) as { value: string };
  const claims = decodeJwtClaims(value);

  return {
    provider: "github",
    issuer: String(claims.iss ?? ""),
    repository: String(claims.repository ?? ""),
    workflow_ref: String(claims.job_workflow_ref ?? claims.workflow_ref ?? ""),
    sha: String(claims.sha ?? ""),
    run_id: String(claims.run_id ?? ""),
    run_attempt: String(claims.run_attempt ?? ""),
  };
}
