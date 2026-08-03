import { NextRequest, NextResponse } from "next/server";
import { userClient } from "@/lib/supabase";

export async function GET(req: NextRequest): Promise<NextResponse> {
  const tokenHash = req.nextUrl.searchParams.get("token_hash");
  const next = req.nextUrl.searchParams.get("next") ?? "/dashboard";
  if (tokenHash) {
    const supabase = await userClient();
    const { error } = await supabase.auth.verifyOtp({ type: "email", token_hash: tokenHash });
    if (!error) return NextResponse.redirect(new URL(next, req.url));
  }
  return NextResponse.redirect(new URL("/login?error=1", req.url));
}
