import { cookies } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { logAccess, resolveShare } from "@/lib/share";

/**
 * The email gate: the strongest identification the access model
 * permits. An email, never an account. The address goes to the access
 * log the customer sees and to the view watermark, and the page says
 * so; collecting it silently would be the kind of move this product
 * exists to make unnecessary.
 */

async function enter(formData: FormData): Promise<void> {
  "use server";
  const slug = String(formData.get("slug") ?? "");
  const email = String(formData.get("email") ?? "").trim();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) redirect(`/s/${slug}/gate?invalid=1`);
  const resolved = await resolveShare(slug);
  if (resolved.state !== "ok") notFound();
  const store = await cookies();
  store.set(`pb_gate_${resolved.share.id}`, email, {
    httpOnly: true,
    sameSite: "lax",
    maxAge: 60 * 60 * 24 * 30,
    path: `/s/${slug}`,
  });
  logAccess(resolved.share.id, "gate:entered", email, null);
  redirect(`/s/${slug}`);
}

export default async function Gate({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ invalid?: string }>;
}) {
  const { slug } = await params;
  const { invalid } = await searchParams;
  const resolved = await resolveShare(slug);
  if (resolved.state !== "ok") notFound();
  if (!resolved.share.email_gate) redirect(`/s/${slug}`);

  return (
    <main className="wrap" style={{ paddingTop: 80, maxWidth: 560 }}>
      <h1>Shared evidence · {resolved.share.label}</h1>
      <p className="small muted">
        {resolved.org.name} asks viewers to identify themselves by email before
        opening this evidence. No account is created; the address appears in
        the access log visible to {resolved.org.name} and watermarks your view.
      </p>
      {invalid && <p className="small" style={{ color: "var(--bad)" }}>Enter a valid email address.</p>}
      <form action={enter}>
        <input type="hidden" name="slug" value={slug} />
        <label htmlFor="gate-email">Work email</label>
        <input id="gate-email" name="email" type="email" required style={{ width: "100%" }} />
        <p>
          <button className="btn btn-dark" type="submit">Open evidence</button>
        </p>
      </form>
    </main>
  );
}
