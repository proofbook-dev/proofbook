import {
  requireEnv,
  SourceError,
  type AdapterContext,
  type SourceAdapter,
  type SourceFile,
} from "./types.js";

/**
 * Grafana Tempo. The one source that speaks OTLP natively: search for
 * trace ids in the window, fetch each trace, rename Tempo's `batches`
 * key to `resourceSpans` and pass the spans through byte-identical
 * otherwise. No conversion, no interpretation.
 */

export const tempo: SourceAdapter = {
  name: "tempo",
  description: "Grafana Tempo traces via the HTTP API (native OTLP)",
  requiredEnv: ["TEMPO_URL"],
  optionalEnv: ["TEMPO_USER + TEMPO_TOKEN (basic auth) or TEMPO_TOKEN alone (bearer)"],

  async fetch(ctx: AdapterContext): Promise<SourceFile[]> {
    const env = requireEnv(this, ctx.env);
    const base = env.TEMPO_URL!.replace(/\/$/, "");
    const headers: Record<string, string> = {};
    if (ctx.env.TEMPO_USER && ctx.env.TEMPO_TOKEN) {
      headers.authorization = `Basic ${Buffer.from(`${ctx.env.TEMPO_USER}:${ctx.env.TEMPO_TOKEN}`).toString("base64")}`;
    } else if (ctx.env.TEMPO_TOKEN) {
      headers.authorization = `Bearer ${ctx.env.TEMPO_TOKEN}`;
    }

    const start = Math.floor(new Date(ctx.window.fromISO).getTime() / 1000);
    const end = Math.floor(new Date(ctx.window.toISO).getTime() / 1000);
    const search = await ctx.fetchImpl(
      `${base}/api/search?start=${start}&end=${end}&limit=1000`,
      { headers },
    );
    if (!search.ok) {
      throw new SourceError(`Tempo search failed (${search.status}). Check TEMPO_URL and credentials.`);
    }
    const found = (await search.json()) as { traces?: { traceID?: string }[] };
    const ids = (found.traces ?? []).flatMap((t) => (t.traceID ? [t.traceID] : []));
    ctx.log(`tempo: ${ids.length} traces in window`);

    const files: SourceFile[] = [];
    for (const id of ids) {
      const resTrace = await ctx.fetchImpl(`${base}/api/traces/${id}`, { headers });
      if (!resTrace.ok) continue;
      const doc = (await resTrace.json()) as Record<string, unknown>;
      const batches = doc.batches ?? doc.resourceSpans;
      if (!batches) continue;
      files.push({ name: `tempo-${id}.json`, content: JSON.stringify({ resourceSpans: batches }) });
    }
    return files;
  },
};
