import { serviceClient } from "./supabase";
import type { StoredBundle } from "./bundles";

/**
 * Share-link resolution: the recipient trust boundary.
 *
 * A share grants a period range and a framework set for one org. Every
 * recipient query goes through here, and the scope is applied before
 * anything touches a renderer, so a screen cannot leak what the grant
 * does not name. Expired and revoked are distinct, honest states, never
 * a 404: the recipient should know the customer withdrew access, not
 * wonder whether the link was ever real.
 */

export interface Share {
  id: string;
  org_id: string;
  slug: string;
  label: string;
  period_from: string | null;
  period_to: string | null;
  frameworks: string[] | null;
  email_gate: boolean;
  expires_at: string;
  revoked_at: string | null;
  created_at: string;
}

export type ShareState =
  | { state: "ok"; share: Share; org: { name: string; slug: string } }
  | { state: "revoked"; share: Share }
  | { state: "expired"; share: Share }
  | { state: "missing" };

export async function resolveShare(slug: string): Promise<ShareState> {
  const db = serviceClient();
  const { data: share } = await db
    .from("share_links")
    .select("*")
    .eq("slug", slug)
    .maybeSingle();
  if (!share) return { state: "missing" };
  if (share.revoked_at) return { state: "revoked", share };
  if (new Date(share.expires_at).getTime() < Date.now()) return { state: "expired", share };
  const { data: org } = await db
    .from("orgs")
    .select("name, slug")
    .eq("id", share.org_id)
    .single();
  return { state: "ok", share, org: org! };
}

/** Bundles inside the grant, nothing else. */
export async function sharedBundles(share: Share): Promise<StoredBundle[]> {
  const db = serviceClient();
  let query = db.from("bundles").select("*").eq("org_id", share.org_id);
  if (share.period_from) query = query.gte("period_label", share.period_from);
  if (share.period_to) query = query.lte("period_label", share.period_to);
  const { data } = await query;
  const bundles = (data ?? []) as StoredBundle[];
  if (!share.frameworks || share.frameworks.length === 0) return bundles;
  // Framework scoping filters the visible verdict summaries and, below
  // the surface, the control files a recipient can see or download.
  return bundles.map((b) => scopeToFrameworks(b, share.frameworks!));
}

function scopeToFrameworks(bundle: StoredBundle, frameworks: string[]): StoredBundle {
  const allowed = new Set(frameworks);
  const files: Record<string, string> = {};
  for (const [path, content] of Object.entries(bundle.files)) {
    const m = path.match(/^controls\/([^/]+)\//);
    if (m && !allowed.has(m[1]!)) continue;
    files[path] = content;
  }
  return {
    ...bundle,
    files,
    frameworks: bundle.frameworks.filter((f) => allowed.has(f)),
    summaries: bundle.summaries.filter((s) => allowed.has(s.framework)),
  };
}

/** Fire-and-forget access log; the render never waits on it. */
export function logAccess(
  shareId: string,
  section: string,
  email: string | null,
  userAgent: string | null,
): void {
  void serviceClient()
    .from("share_access_log")
    .insert({ share_id: shareId, section, email, user_agent: userAgent })
    .then(() => {});
}
