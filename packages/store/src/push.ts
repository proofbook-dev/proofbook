/**
 * Push a sealed bundle to the hosted evidence chain.
 *
 * The only thing that ever crosses this boundary is the bundle itself:
 * megabytes of verdicts, digests and signatures. The hosted service is
 * not part of this build; this client speaks a minimal contract
 * (POST /v1/bundles, bearer token) so CI can push the moment the
 * service exists, and tests can stand up a fake in one line.
 */

export interface PushOptions {
  url?: string | undefined;
  token?: string | undefined;
  /** Report language metadata, sent beside the bundle, never inside it. */
  language?: string | undefined;
  fetchImpl?: typeof fetch | undefined;
}

export interface PushResult {
  id: string;
  root: string;
}

export class PushError extends Error {}

export async function pushBundle(
  files: Map<string, string>,
  root: string,
  opts: PushOptions = {},
): Promise<PushResult> {
  const url = opts.url ?? process.env.PROOFBOOK_URL ?? "https://api.proofbook.dev";
  const token = opts.token ?? process.env.PROOFBOOK_TOKEN;
  if (!token) {
    throw new PushError(
      "No PROOFBOOK_TOKEN set. Pushing feeds the hosted chain (portal links, sealed history); " +
        "the free tier keeps bundles local or as CI artifacts, no push needed.",
    );
  }
  const doFetch = opts.fetchImpl ?? fetch;

  let res: Response;
  try {
    res = await doFetch(`${url.replace(/\/$/, "")}/v1/bundles`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        root,
        files: Object.fromEntries(files),
        ...(opts.language ? { language: opts.language } : {}),
      }),
    });
  } catch (err) {
    throw new PushError(
      `Could not reach ${url}: ${(err as Error).message}. The bundle is sealed and safe locally; retry when the network allows.`,
    );
  }
  if (!res.ok) {
    throw new PushError(
      `Push rejected (${res.status}). The bundle is sealed and safe locally; nothing was lost.`,
    );
  }
  const body = (await res.json().catch(() => ({}))) as { id?: string };
  return { id: body.id ?? root, root };
}

/**
 * Push the encrypted archive for an already-pushed root. The API hands
 * back a signed storage URL and the ciphertext goes there directly,
 * bypassing any API body-size limit. The server stores what it cannot
 * read: the key never travels.
 */
export async function pushArchive(
  bytes: Uint8Array,
  meta: { root: string; key_id: string; digest: string },
  opts: PushOptions = {},
): Promise<void> {
  const url = (opts.url ?? process.env.PROOFBOOK_URL ?? "https://api.proofbook.dev").replace(/\/$/, "");
  const token = opts.token ?? process.env.PROOFBOOK_TOKEN;
  if (!token) throw new PushError("No PROOFBOOK_TOKEN set.");
  const doFetch = opts.fetchImpl ?? fetch;

  const res = await doFetch(`${url}/v1/archives`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ root: meta.root, bytes: bytes.length, key_id: meta.key_id, digest: meta.digest }),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new PushError(body.error ?? `Archive refused (${res.status}). The bundle push already succeeded.`);
  }
  const { upload_url } = (await res.json()) as { upload_url: string };

  const put = await doFetch(upload_url, {
    method: "PUT",
    headers: { "content-type": "application/octet-stream", "x-upsert": "true" },
    body: bytes,
  });
  if (!put.ok) {
    throw new PushError(`Archive upload failed (${put.status}). The bundle push already succeeded; retry proof push.`);
  }
}

export interface DeleteResult {
  subject: string;
  bundles: number;
  attestations: number;
  archives: number;
  shares: number;
}

/**
 * Delete a subject's whole evidence set from the hosted chain: every
 * sealed period and re-seal, its declared sign-offs, encrypted archives
 * and any share link left covering nothing. Irreversible on the server.
 * Local bundles, traces and keys are never touched: this speaks only to
 * the hosted API, and only about what was pushed there.
 */
export async function deleteEvidence(subject: string, opts: PushOptions = {}): Promise<DeleteResult> {
  const url = (opts.url ?? process.env.PROOFBOOK_URL ?? "https://api.proofbook.dev").replace(/\/$/, "");
  const token = opts.token ?? process.env.PROOFBOOK_TOKEN;
  if (!token) {
    throw new PushError(
      "No PROOFBOOK_TOKEN set. Deleting affects the hosted chain (portal history, share " +
        "links); set the org token before deleting.",
    );
  }
  const doFetch = opts.fetchImpl ?? fetch;

  let res: Response;
  try {
    res = await doFetch(`${url}/v1/bundles?subject=${encodeURIComponent(subject)}`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${token}` },
    });
  } catch (err) {
    throw new PushError(`Could not reach ${url}: ${(err as Error).message}. Nothing was deleted.`);
  }
  const body = (await res.json().catch(() => ({}))) as Partial<DeleteResult> & { error?: string };
  if (!res.ok) {
    throw new PushError(body.error ?? `Delete rejected (${res.status}). Nothing was deleted.`);
  }
  return {
    subject,
    bundles: body.bundles ?? 0,
    attestations: body.attestations ?? 0,
    archives: body.archives ?? 0,
    shares: body.shares ?? 0,
  };
}

export interface EvidenceSet {
  subject: string;
  bundles: number;
  live: number;
  periods: string[];
  latest_period: string | null;
  latest_root: string;
}

/**
 * List the evidence sets on the hosted chain for this org (grouped by
 * subject), so a developer can see what exists before deleting. Read-only.
 */
export async function listEvidence(opts: PushOptions = {}): Promise<EvidenceSet[]> {
  const url = (opts.url ?? process.env.PROOFBOOK_URL ?? "https://api.proofbook.dev").replace(/\/$/, "");
  const token = opts.token ?? process.env.PROOFBOOK_TOKEN;
  if (!token) {
    throw new PushError("No PROOFBOOK_TOKEN set. Listing reads the hosted chain; set the org token first.");
  }
  const doFetch = opts.fetchImpl ?? fetch;

  let res: Response;
  try {
    res = await doFetch(`${url}/v1/bundles`, { headers: { authorization: `Bearer ${token}` } });
  } catch (err) {
    throw new PushError(`Could not reach ${url}: ${(err as Error).message}.`);
  }
  const body = (await res.json().catch(() => ({}))) as { sets?: EvidenceSet[]; error?: string };
  if (!res.ok) {
    throw new PushError(body.error ?? `List rejected (${res.status}).`);
  }
  return body.sets ?? [];
}
