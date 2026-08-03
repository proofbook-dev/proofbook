import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { serviceClient, userClient } from "@/lib/supabase";

/**
 * The access log for one share link: who opened it, when, which
 * sections. The signal a founder actually wants (did the buyer look),
 * and the recipient is told at the gate that this log exists.
 */

export default async function ShareLog({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const supabase = await userClient();
  const { data: auth } = await supabase.auth.getUser();
  if (!auth.user) redirect("/login");

  const db = serviceClient();
  const { data: share } = await db.from("share_links").select("*").eq("id", id).maybeSingle();
  if (!share) notFound();
  const { data: member } = await db
    .from("org_members")
    .select("org_id")
    .eq("user_id", auth.user.id)
    .eq("org_id", share.org_id)
    .maybeSingle();
  if (!member) notFound();

  const { data: log } = await db
    .from("share_access_log")
    .select("*")
    .eq("share_id", id)
    .order("at", { ascending: false })
    .limit(500);

  return (
    <main className="wrap">
      <p className="small" style={{ marginTop: 20 }}>
        <Link href="/dashboard">← Dashboard</Link>
      </p>
      <h1>Access log · {share.label}</h1>
      <p className="small muted">
        <code>/s/{share.slug}</code> ·{" "}
        {share.revoked_at ? "revoked" : `expires ${share.expires_at.slice(0, 10)}`}
        {share.email_gate ? " · email gate on" : " · email gate off (viewers may be anonymous)"}
      </p>
      {(log ?? []).length === 0 && <p className="muted">Not opened yet.</p>}
      {(log ?? []).length > 0 && (
        <table>
          <thead><tr><th>When (UTC)</th><th>Who</th><th>Section</th></tr></thead>
          <tbody>
            {(log ?? []).map((entry) => (
              <tr key={entry.id}>
                <td className="small">{entry.at.replace("T", " ").slice(0, 19)}</td>
                <td className="small">{entry.email ?? <span className="muted">anonymous</span>}</td>
                <td className="small"><code>{entry.section}</code></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </main>
  );
}
