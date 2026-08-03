import { cookies, headers } from "next/headers";
import Link from "next/link";
import { redirect } from "next/navigation";
import { logAccess, resolveShare } from "@/lib/share";

/**
 * The recipient shell. Resolves the share once per request, renders the
 * honest terminal states (revoked and expired are told apart, neither
 * is a 404), enforces the email gate, watermarks the view with the
 * collected identifier, and writes the access log entry the customer
 * sees. Everything inside is server-rendered and works without
 * JavaScript.
 */

export default async function ShareLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const resolved = await resolveShare(slug);

  if (resolved.state === "missing") {
    return (
      <main className="wrap" style={{ paddingTop: 80, maxWidth: 560 }}>
        <h1>No evidence at this address</h1>
        <p className="muted">
          This link does not correspond to a shared evidence grant. Check the
          address with whoever sent it.
        </p>
      </main>
    );
  }
  if (resolved.state !== "ok") {
    return (
      <main className="wrap" style={{ paddingTop: 80, maxWidth: 560 }}>
        <h1>{resolved.state === "revoked" ? "Access withdrawn" : "Link expired"}</h1>
        <p className="muted">
          {resolved.state === "revoked"
            ? "The company that shared this evidence has revoked access to it."
            : `This link expired on ${new Date(resolved.share.expires_at).toISOString().slice(0, 10)}.`}{" "}
          Request a new link from your contact there. Evidence already
          downloaded remains independently verifiable.
        </p>
      </main>
    );
  }

  const { share, org } = resolved;
  const store = await cookies();
  const email = store.get(`pb_gate_${share.id}`)?.value ?? null;
  if (share.email_gate && !email) redirect(`/s/${slug}/gate`);

  const hdrs = await headers();
  logAccess(share.id, hdrs.get("x-pb-section") ?? "view", email, hdrs.get("user-agent"));

  const base = `/s/${slug}`;
  return (
    <>
      <div className="watermark">{email ?? org.name}</div>
      <header className="topbar wrap">
        <span>
          <span className="brand">proofbook</span>{" "}
          <span className="muted">· shared evidence · {share.label}</span>
        </span>
        <span className="muted small">
          {email ? `viewing as ${email} · ` : ""}
          expires {new Date(share.expires_at).toISOString().slice(0, 10)}
        </span>
      </header>
      <main className="wrap">
        <nav className="tabs" aria-label="Sections">
          <Link href={base}>Overview</Link>
          <Link href={`${base}/controls`}>Controls</Link>
          <Link href={`${base}/chain`}>Chain</Link>
          <Link href={`${base}/verify`}>Verify independently</Link>
        </nav>
        {children}
        <footer>
          Produced from sealed evidence bundles; verification does not require
          this site or any Proofbook service. Content is digests only by
          design. <Link href={`${base}/verify`}>Verification spec</Link>
        </footer>
      </main>
    </>
  );
}
