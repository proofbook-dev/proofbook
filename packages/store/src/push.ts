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
      body: JSON.stringify({ root, files: Object.fromEntries(files) }),
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
