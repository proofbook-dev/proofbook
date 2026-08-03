import { redirect } from "next/navigation";
import { userClient } from "@/lib/supabase";

/** Customer sign-in: magic link only, no passwords to leak. */

async function sendLink(formData: FormData): Promise<void> {
  "use server";
  const email = String(formData.get("email") ?? "").trim();
  const supabase = await userClient();
  const { error } = await supabase.auth.signInWithOtp({
    email,
    options: { emailRedirectTo: `${process.env.NEXT_PUBLIC_PORTAL_URL}/auth/confirm` },
  });
  redirect(error ? "/login?error=1" : "/login?sent=1");
}

export default async function Login({
  searchParams,
}: {
  searchParams: Promise<{ sent?: string; error?: string }>;
}) {
  const q = await searchParams;
  return (
    <main className="wrap" style={{ paddingTop: 80, maxWidth: 480 }}>
      <h1>Sign in</h1>
      <p className="small muted">
        For teams producing evidence. Evidence recipients never need an
        account; they arrive through a share link.
      </p>
      {q.sent && <p className="small check-ok">Check your email for a sign-in link.</p>}
      {q.error && <p className="small" style={{ color: "var(--bad)" }}>Could not send the link. Try again.</p>}
      <form action={sendLink}>
        <label htmlFor="login-email">Work email</label>
        <input id="login-email" name="email" type="email" required style={{ width: "100%" }} />
        <p><button className="btn btn-dark" type="submit">Email me a sign-in link</button></p>
      </form>
    </main>
  );
}
