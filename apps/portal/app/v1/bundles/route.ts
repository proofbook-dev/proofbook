import { createHash } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { verifyBundleFiles } from "@proofbook/seal";
import { serviceClient } from "@/lib/supabase";

/**
 * POST /v1/bundles: the receiving end of `proof push`.
 *
 * The contract is the CLI's (packages/store/src/push.ts): bearer token,
 * JSON body { root, files }. The server re-verifies every bundle on
 * receipt with the same open-source verifier a recipient runs offline;
 * a bundle that fails verification is refused, not stored quietly. What
 * the portal later shows is exactly what was pushed, or nothing.
 *
 * Idempotent per (org, root): pushing the same sealed bundle twice is a
 * no-op, matching the CLI's own idempotency rule. A different root for
 * an already-sealed period supersedes, and the supersession is recorded
 * rather than hidden, mirroring `proof seal --supersede`.
 */

export async function POST(req: NextRequest): Promise<NextResponse> {
  const auth = req.headers.get("authorization") ?? "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : null;
  if (!token) return NextResponse.json({ error: "missing bearer token" }, { status: 401 });

  const db = serviceClient();
  const tokenHash = createHash("sha256").update(token, "utf8").digest("hex");
  const { data: apiToken } = await db
    .from("api_tokens")
    .select("id, org_id, revoked_at")
    .eq("token_hash", tokenHash)
    .maybeSingle();
  if (!apiToken || apiToken.revoked_at) {
    return NextResponse.json({ error: "invalid token" }, { status: 401 });
  }

  let body: { root?: string; files?: Record<string, string> };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "body must be JSON" }, { status: 400 });
  }
  if (!body.root || !body.files || typeof body.files !== "object") {
    return NextResponse.json({ error: "body must be { root, files }" }, { status: 400 });
  }

  const files = new Map(Object.entries(body.files));
  const verification = verifyBundleFiles(files);
  if (!verification.ok || verification.root !== body.root) {
    return NextResponse.json(
      {
        error: "bundle failed verification; nothing was stored",
        checks: verification.checks.filter((c) => !c.ok),
      },
      { status: 422 },
    );
  }

  const manifest = JSON.parse(files.get("manifest.json")!) as {
    subject: string;
    period: { label?: string; from: string; to: string } | null;
    previous: string | null;
    crosswalks: { framework: string }[];
    summaries: Record<string, unknown>[];
  };

  const provenance_mode = files.has("provenance/sigstore.json")
    ? "sigstore-oidc"
    : "local-ed25519";

  const { data: existing } = await db
    .from("bundles")
    .select("id")
    .eq("org_id", apiToken.org_id)
    .eq("root", body.root)
    .maybeSingle();
  if (existing) {
    void db.from("api_tokens").update({ last_used_at: new Date().toISOString() }).eq("id", apiToken.id).then(() => {});
    return NextResponse.json({ id: existing.id, root: body.root });
  }

  const { data: inserted, error } = await db
    .from("bundles")
    .insert({
      org_id: apiToken.org_id,
      root: body.root,
      previous_root: manifest.previous,
      subject: manifest.subject,
      period_label: manifest.period?.label ?? null,
      period_from: manifest.period?.from ?? null,
      period_to: manifest.period?.to ?? null,
      frameworks: manifest.crosswalks.map((c) => c.framework),
      summaries: manifest.summaries,
      verification,
      verification_ok: verification.ok,
      provenance_mode,
      files: body.files,
    })
    .select("id")
    .single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  // Same period, different root: the newest push supersedes. Recorded,
  // never silent; the chain screen renders the supersession.
  if (manifest.period?.label) {
    await db
      .from("bundles")
      .update({ superseded_by: body.root })
      .eq("org_id", apiToken.org_id)
      .eq("period_label", manifest.period.label)
      .neq("root", body.root)
      .is("superseded_by", null);
  }

  await db.from("api_tokens").update({ last_used_at: new Date().toISOString() }).eq("id", apiToken.id);
  return NextResponse.json({ id: inserted.id, root: body.root }, { status: 201 });
}
