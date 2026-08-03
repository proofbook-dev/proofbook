import Link from "next/link";
import { redirect } from "next/navigation";
import { serviceClient, userClient } from "@/lib/supabase";
import { assembleChain, type StoredBundle } from "@/lib/bundles";
import {
  createOrg,
  createShare,
  createToken,
  extendShare,
  revokeShare,
  revokeToken,
  signOut,
} from "./actions";

/**
 * The customer surface: push tokens, received bundles, share links and
 * their access logs. Deliberately minimal; the evidence itself is the
 * product, and the recipient portal is where it is read. This is not
 * an analytics dashboard and must not grow into one.
 */

export default async function Dashboard({
  searchParams,
}: {
  searchParams: Promise<{ token?: string }>;
}) {
  const q = await searchParams;
  const supabase = await userClient();
  const { data: auth } = await supabase.auth.getUser();
  if (!auth.user) redirect("/login");

  const db = serviceClient();
  const { data: member } = await db
    .from("org_members")
    .select("org_id, orgs(name, slug)")
    .eq("user_id", auth.user.id)
    .limit(1)
    .maybeSingle();

  if (!member) {
    return (
      <main className="wrap" style={{ paddingTop: 80, maxWidth: 480 }}>
        <h1>Create your organisation</h1>
        <p className="small muted">Named after the company whose agents produce the evidence.</p>
        <form action={createOrg}>
          <label htmlFor="org-name">Organisation name</label>
          <input id="org-name" name="name" required style={{ width: "100%" }} />
          <p><button className="btn btn-dark" type="submit">Create</button></p>
        </form>
      </main>
    );
  }

  const orgId = member.org_id;
  const org = member.orgs as unknown as { name: string; slug: string };
  const [{ data: bundles }, { data: tokens }, { data: shares }] = await Promise.all([
    db.from("bundles").select("*").eq("org_id", orgId).order("period_from"),
    db.from("api_tokens").select("*").eq("org_id", orgId).order("created_at"),
    db.from("share_links").select("*, share_access_log(count)").eq("org_id", orgId).order("created_at"),
  ]);
  const chain = assembleChain((bundles ?? []) as StoredBundle[]);

  return (
    <>
      <header className="topbar wrap">
        <span><span className="brand">proofbook</span> <span className="muted">· {org.name}</span></span>
        <form action={signOut}><button className="btn" type="submit">Sign out</button></form>
      </header>
      <main className="wrap">
        <h1>Evidence chain</h1>
        {chain.length === 0 && (
          <p className="muted">
            No bundles yet. Seal locally and push with <code>proof push</code>, or add
            the evidence Action with <code>push: &quot;true&quot;</code>.
          </p>
        )}
        {chain.map((entry, i) =>
          entry.kind === "gap" ? (
            <div className="gapbox" key={i}>Gap: {entry.labels.join(", ")} never sealed.</div>
          ) : (
            <p key={i} className="small" style={{ fontFamily: "var(--mono)" }}>
              {entry.bundle.period_label ?? "ad hoc"} · {entry.bundle.root.slice(0, 20)}… ·{" "}
              {entry.bundle.verification_ok ? "verified" : "FAILED VERIFICATION"} ·{" "}
              {entry.bundle.provenance_mode}
            </p>
          ),
        )}

        <h2>Push tokens</h2>
        {q.token && (
          <div className="card">
            <p className="small"><strong>Copy this token now; it is not shown again.</strong></p>
            <pre>{q.token}</pre>
            <p className="small muted">
              Set it as <code>PROOFBOOK_TOKEN</code> in CI. <code>proof push</code> sends
              sealed bundles only: verdicts, digests and signatures, never traces.
            </p>
          </div>
        )}
        <table>
          <thead><tr><th>Name</th><th>Prefix</th><th>Last used</th><th></th></tr></thead>
          <tbody>
            {(tokens ?? []).map((t) => (
              <tr key={t.id}>
                <td>{t.name}</td>
                <td><code>{t.prefix}…</code></td>
                <td className="small muted">
                  {t.revoked_at ? "revoked" : t.last_used_at?.slice(0, 10) ?? "never"}
                </td>
                <td>
                  {!t.revoked_at && (
                    <form action={revokeToken}>
                      <input type="hidden" name="id" value={t.id} />
                      <button className="btn" type="submit">Revoke</button>
                    </form>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <form action={createToken} className="filters" style={{ marginTop: 10 }}>
          <span>
            <label htmlFor="tok-name">New token name</label>
            <input id="tok-name" name="name" placeholder="github-actions" />
          </span>
          <button className="btn btn-dark" type="submit">Create token</button>
        </form>

        <h2>Share links</h2>
        <p className="small muted">
          A link grants named periods and frameworks, never the account. 30-day
          expiry by default, revocable instantly, access logged.
        </p>
        <table>
          <thead>
            <tr><th>Label</th><th>Scope</th><th>Expires</th><th>Opens</th><th>Link</th><th></th></tr>
          </thead>
          <tbody>
            {(shares ?? []).map((s) => {
              const expired = new Date(s.expires_at).getTime() < Date.now();
              const opens = (s.share_access_log?.[0] as { count?: number } | undefined)?.count ?? 0;
              return (
                <tr key={s.id}>
                  <td>{s.label}</td>
                  <td className="small">
                    {s.period_from || s.period_to
                      ? `${s.period_from ?? "…"} → ${s.period_to ?? "…"}`
                      : "all periods"}
                    {" · "}
                    {s.frameworks?.join(", ") ?? "all frameworks"}
                    {s.email_gate ? " · email gate" : ""}
                  </td>
                  <td className="small muted">
                    {s.revoked_at ? "revoked" : expired ? "expired" : s.expires_at.slice(0, 10)}
                  </td>
                  <td className="small">
                    <Link href={`/dashboard/shares/${s.id}`}>{opens} logged</Link>
                  </td>
                  <td className="small"><code>/s/{s.slug}</code></td>
                  <td>
                    <div style={{ display: "flex", gap: 6 }}>
                      {!s.revoked_at && !expired ? (
                        <form action={revokeShare}>
                          <input type="hidden" name="id" value={s.id} />
                          <button className="btn" type="submit">Revoke</button>
                        </form>
                      ) : (
                        <form action={extendShare}>
                          <input type="hidden" name="id" value={s.id} />
                          <button className="btn" type="submit">Reissue +30d</button>
                        </form>
                      )}
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        <form action={createShare} className="filters" style={{ marginTop: 10 }}>
          <span>
            <label htmlFor="sh-label">Label (recipient-visible)</label>
            <input id="sh-label" name="label" placeholder="Acme Bank vendor review" required />
          </span>
          <span>
            <label htmlFor="sh-from">Period from</label>
            <input id="sh-from" name="period_from" placeholder="2026-05" size={8} />
          </span>
          <span>
            <label htmlFor="sh-to">Period to</label>
            <input id="sh-to" name="period_to" placeholder="2026-07" size={8} />
          </span>
          <span>
            <label htmlFor="sh-fw">Frameworks (comma, empty = all)</label>
            <input id="sh-fw" name="frameworks" placeholder="eu-ai-act" />
          </span>
          <span>
            <label htmlFor="sh-days">Days</label>
            <input id="sh-days" name="days" defaultValue={30} size={4} />
          </span>
          <span>
            <label htmlFor="sh-gate">Email gate</label>
            <input id="sh-gate" name="email_gate" type="checkbox" />
          </span>
          <button className="btn btn-dark" type="submit">Create link</button>
        </form>
      </main>
    </>
  );
}
