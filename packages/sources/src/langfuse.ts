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
 * call spans; AGENT and TOOL observations become invoke_agent and
 * execute_tool spans, and observations whose metadata declares a
 * checkpoint become proofbook.human_checkpoint spans, mirroring the
 * Datadog and LangSmith adapters so the same mapping rules apply.
 * Provider comes from Langfuse metadata when present and is otherwise
 * omitted, which the normaliser records as a missing required field
 * rather than a guessed vendor.
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
  input?: unknown;
  output?: unknown;
}

const asText = (v: unknown): string | undefined =>
  v === undefined || v === null ? undefined : typeof v === "string" ? v : JSON.stringify(v);

/** One observation → the gen_ai.* / proofbook.* attribute set the OTel
 * GenAI generation rules recognise. The observation type drives it. */
function lfAttrs(o: LfObservation): Record<string, string | number | boolean | undefined> {
  const meta = o.metadata ?? {};
  switch (o.type) {
    case "GENERATION": {
      const provider =
        (meta.ls_provider as string | undefined) ?? (meta.provider as string | undefined);
      return {
        "gen_ai.operation.name": "chat",
        "gen_ai.system": provider,
        "gen_ai.request.model": o.model,
        "gen_ai.usage.input_tokens": o.usage?.input,
        "gen_ai.usage.output_tokens": o.usage?.output,
        "gen_ai.prompt": asText(o.input),
        "gen_ai.completion": asText(o.output),
        "langfuse.observation.id": o.id,
      };
    }
    case "AGENT":
      return {
        "gen_ai.operation.name": "invoke_agent",
        "gen_ai.agent.id": String(meta.agent_id ?? o.name ?? "agent"),
        "gen_ai.agent.name": o.name,
        "session.id": meta.session_id ? String(meta.session_id) : undefined,
        "langfuse.observation.id": o.id,
      };
    case "TOOL":
      return {
        "gen_ai.operation.name": "execute_tool",
        "gen_ai.tool.name": o.name,
        "gen_ai.tool.call.arguments": asText(o.input),
        "gen_ai.tool.call.result": asText(o.output),
        "langfuse.observation.id": o.id,
      };
    default: {
      const attrs: Record<string, string | number | boolean | undefined> = {
        "langfuse.observation.type": o.type,
        "langfuse.observation.id": o.id,
      };
      // A span or event whose metadata declares a checkpoint is human
      // oversight; without the declaration these controls stay unevaluable.
      if (meta.checkpoint_type || meta.human_checkpoint === "true") {
        attrs["proofbook.human_checkpoint.type"] = String(meta.checkpoint_type ?? "approval");
        if (meta.decision) attrs["proofbook.human_checkpoint.decision"] = String(meta.decision);
        if (meta.actor) attrs["proofbook.human_checkpoint.actor"] = String(meta.actor);
      }
      return attrs;
    }
  }
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
      const spans = observations.map((o) =>
        otlpSpan({
          traceId: o.traceId ?? hexId(o.id, 16),
          spanId: hexId(o.id, 8),
          parentSpanId: o.parentObservationId ? hexId(o.parentObservationId, 8) : undefined,
          name: o.name ?? o.type.toLowerCase(),
          startISO: o.startTime,
          endISO: o.endTime,
          attrs: lfAttrs(o),
        }),
      );
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
