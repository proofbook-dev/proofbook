"use server";

import { createHash, randomBytes } from "node:crypto";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { serviceClient, userClient } from "@/lib/supabase";

/**
 * Customer mutations. Auth is checked here (not only in the page) and
 * org membership is re-verified per action, because server actions are
 * routable endpoints. Token plaintext exists for exactly one response.
 */

async function requireUserOrg(): Promise<{ userId: string; orgId: string }> {
  const supabase = await userClient();
  const { data } = await supabase.auth.getUser();
  if (!data.user) redirect("/login");
  const db = serviceClient();
  const { data: member } = await db
    .from("org_members")
    .select("org_id")
    .eq("user_id", data.user.id)
    .limit(1)
    .maybeSingle();
  if (!member) redirect("/dashboard");
  return { userId: data.user.id, orgId: member.org_id };
}

export async function createOrg(formData: FormData): Promise<void> {
  const supabase = await userClient();
  const { data } = await supabase.auth.getUser();
  if (!data.user) redirect("/login");
  const name = String(formData.get("name") ?? "").trim();
  if (!name) return;
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  const db = serviceClient();
  const { data: org, error } = await db
    .from("orgs")
    .insert({ name, slug: `${slug}-${randomBytes(3).toString("hex")}` })
    .select("id")
    .single();
  if (error) throw new Error(error.message);
  await db.from("org_members").insert({ org_id: org.id, user_id: data.user.id, role: "owner" });
  revalidatePath("/dashboard");
}

export async function createToken(formData: FormData): Promise<void> {
  const { userId, orgId } = await requireUserOrg();
  const name = String(formData.get("name") ?? "CI").trim() || "CI";
  const plaintext = `pbk_${randomBytes(24).toString("hex")}`;
  const db = serviceClient();
  await db.from("api_tokens").insert({
    org_id: orgId,
    name,
    token_hash: createHash("sha256").update(plaintext, "utf8").digest("hex"),
    prefix: plaintext.slice(0, 10),
    created_by: userId,
  });
  redirect(`/dashboard?token=${plaintext}`);
}

export async function revokeToken(formData: FormData): Promise<void> {
  const { orgId } = await requireUserOrg();
  await serviceClient()
    .from("api_tokens")
    .update({ revoked_at: new Date().toISOString() })
    .eq("id", String(formData.get("id")))
    .eq("org_id", orgId);
  revalidatePath("/dashboard");
}

export async function createShare(formData: FormData): Promise<void> {
  const { userId, orgId } = await requireUserOrg();
  const label = String(formData.get("label") ?? "").trim();
  if (!label) return;
  const days = Number(formData.get("days") ?? 30) || 30;
  const frameworks = String(formData.get("frameworks") ?? "").trim();
  const periodFrom = String(formData.get("period_from") ?? "").trim();
  const periodTo = String(formData.get("period_to") ?? "").trim();
  await serviceClient().from("share_links").insert({
    org_id: orgId,
    slug: randomBytes(12).toString("base64url"),
    label,
    period_from: periodFrom || null,
    period_to: periodTo || null,
    frameworks: frameworks ? frameworks.split(",").map((f) => f.trim()) : null,
    email_gate: formData.get("email_gate") === "on",
    expires_at: new Date(Date.now() + days * 86400_000).toISOString(),
    created_by: userId,
  });
  revalidatePath("/dashboard");
}

export async function revokeShare(formData: FormData): Promise<void> {
  const { orgId } = await requireUserOrg();
  await serviceClient()
    .from("share_links")
    .update({ revoked_at: new Date().toISOString() })
    .eq("id", String(formData.get("id")))
    .eq("org_id", orgId);
  revalidatePath("/dashboard");
}

export async function extendShare(formData: FormData): Promise<void> {
  const { orgId } = await requireUserOrg();
  const { data: share } = await serviceClient()
    .from("share_links")
    .select("expires_at")
    .eq("id", String(formData.get("id")))
    .eq("org_id", orgId)
    .single();
  if (!share) return;
  const base = Math.max(Date.now(), new Date(share.expires_at).getTime());
  await serviceClient()
    .from("share_links")
    .update({ expires_at: new Date(base + 30 * 86400_000).toISOString(), revoked_at: null })
    .eq("id", String(formData.get("id")))
    .eq("org_id", orgId);
  revalidatePath("/dashboard");
}

export async function signOut(): Promise<void> {
  const supabase = await userClient();
  await supabase.auth.signOut();
  redirect("/login");
}
