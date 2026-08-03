import { NextRequest, NextResponse } from "next/server";
import { resolveShare, sharedBundles, logAccess } from "@/lib/share";

/**
 * Bundle download, scoped by the share grant. The payload is the same
 * { root, files } shape the CLI pushed, which `proofbook verify`
 * accepts directly. Framework scoping applies here too: a recipient
 * downloads exactly what the grant lets them see.
 */

export async function GET(
  req: NextRequest,
  ctx: { params: Promise<{ slug: string; file: string }> },
): Promise<NextResponse> {
  const { slug, file } = await ctx.params;
  const root = file.replace(/\.json$/, "");
  const resolved = await resolveShare(slug);
  if (resolved.state !== "ok") return NextResponse.json({ error: "not available" }, { status: 404 });

  const bundles = await sharedBundles(resolved.share);
  const bundle = bundles.find((b) => b.root === root);
  if (!bundle) return NextResponse.json({ error: "not in this grant" }, { status: 404 });

  logAccess(resolved.share.id, `download:${root.slice(0, 12)}`, null, req.headers.get("user-agent"));
  return new NextResponse(JSON.stringify({ root: bundle.root, files: bundle.files }, null, 2), {
    headers: {
      "content-type": "application/json",
      "content-disposition": `attachment; filename="proofbook-${bundle.period_label ?? bundle.root.slice(0, 12)}.json"`,
    },
  });
}
