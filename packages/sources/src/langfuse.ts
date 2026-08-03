import {
  hexId,
  otlpDocument,
  otlpSpan,
  requireEnv,
  SourceError,
  type AdapterContext,
  type SourceAdapter,
  type SourceFile,
} from "./types.js";

/**
 * Langfuse public API (observations). Generations become gen_ai model
 * call spans; provider comes from Langfuse metadata when present and is
 * otherwise omitted, which the normaliser records honestly as a missing
 * required field rather than a guessed vendor.
 */

interface LfObservation {
  id: string;
  traceId?: string;
  parentObservationId?: string;
  type: string;
  name?: string;
  startTime: string;
  endTime?: string;
  model?: string;
  usage?: { input?: number; output?: number };
  metadata?: Record<string, unknown>;
}

export const langfuse: SourceAdapter = {
  name: "langfuse",
  description: "Langfuse observations via the public API",
  requiredEnv: ["LANGFUSE_PUBLIC_KEY", "LANGFUSE_SECRET_KEY"],
  optionalEnv: ["LANGFUSE_HOST (default https://cloud.langfuse.com)"],

  async fetch(ctx: AdapterContext): Promise<SourceFile[]> {
    const env = requireEnv(this, ctx.env);
    const host = (ctx.env.LANGFUSE_HOST ?? "https://cloud.langfuse.com").replace(/\/$/, "");
    const auth = `Basic ${Buffer.from(`${env.LANGFUSE_PUBLIC_KEY}:${env.LANGFUSE_SECRET_KEY}`).toString("base64")}`;
    const files: SourceFile[] = [];

    for (let page = 1; ; page += 1) {
      const url = new URL(`${host}/api/public/observations`);
      url.searchParams.set("page", String(page));
      url.searchParams.set("limit", "100");
      url.searchParams.set("fromStartTime", ctx.window.fromISO);
      url.searchParams.set("toStartTime", ctx.window.toISO);
      const res = await ctx.fetchImpl(url.toString(), { headers: { authorization: auth } });
      if (!res.ok) {
        throw new SourceError(`Langfuse rejected the request (${res.status}). Check the key pair and LANGFUSE_HOST.`);
      }
      const body = (await res.json()) as {
        data?: LfObservation[];
        meta?: { totalPages?: number };
      };
      const observations = body.data ?? [];
      const spans = observations.map((o) => {
        const provider =
          (o.metadata?.ls_provider as string | undefined) ??
          (o.metadata?.provider as string | undefined);
        const isGeneration = o.type === "GENERATION";
        return otlpSpan({
          traceId: o.traceId ?? hexId(o.id, 16),
          spanId: hexId(o.id, 8),
          parentSpanId: o.parentObservationId ? hexId(o.parentObservationId, 8) : undefined,
          name: o.name ?? o.type.toLowerCase(),
          startISO: o.startTime,
          endISO: o.endTime,
          attrs: isGeneration
            ? {
                "gen_ai.operation.name": "chat",
                "gen_ai.system": provider,
                "gen_ai.request.model": o.model,
                "gen_ai.usage.input_tokens": o.usage?.input,
                "gen_ai.usage.output_tokens": o.usage?.output,
                "langfuse.observation.id": o.id,
              }
            : { "langfuse.observation.type": o.type, "langfuse.observation.id": o.id },
        });
      });
      if (spans.length > 0) {
        files.push({
          name: `langfuse-${String(page).padStart(4, "0")}.json`,
          content: JSON.stringify(otlpDocument("langfuse-import", spans)),
        });
      }
      ctx.log(`langfuse: page ${page}, ${observations.length} observations`);
      if (!body.meta?.totalPages || page >= body.meta.totalPages || observations.length === 0) break;
    }

    return files;
  },
};
