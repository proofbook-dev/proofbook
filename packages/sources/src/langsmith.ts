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
 * LangSmith runs API. llm runs become gen_ai model-call spans, tool
 * runs become execute_tool spans, root chain runs become invoke_agent
 * spans; everything else passes through as plain spans for coverage
 * accounting.
 */

interface LsRun {
  id: string;
  trace_id?: string;
  parent_run_id?: string | null;
  name?: string;
  run_type?: string;
  start_time?: string;
  end_time?: string;
  prompt_tokens?: number;
  completion_tokens?: number;
  extra?: {
    invocation_params?: { model?: string; model_name?: string };
    metadata?: { ls_provider?: string };
  };
}

function runAttrs(run: LsRun): Record<string, string | number | boolean | undefined> {
  const model = run.extra?.invocation_params?.model ?? run.extra?.invocation_params?.model_name;
  switch (run.run_type) {
    case "llm":
      return {
        "gen_ai.operation.name": "chat",
        "gen_ai.system": run.extra?.metadata?.ls_provider,
        "gen_ai.request.model": model,
        "gen_ai.usage.input_tokens": run.prompt_tokens,
        "gen_ai.usage.output_tokens": run.completion_tokens,
        "langsmith.run.id": run.id,
      };
    case "tool":
      return {
        "gen_ai.operation.name": "execute_tool",
        "gen_ai.tool.name": run.name,
        "langsmith.run.id": run.id,
      };
    case "chain":
      return run.parent_run_id
        ? { "langsmith.run.type": "chain", "langsmith.run.id": run.id }
        : {
            "gen_ai.operation.name": "invoke_agent",
            "gen_ai.agent.id": run.name,
            "gen_ai.agent.name": run.name,
            "langsmith.run.id": run.id,
          };
    default:
      return { "langsmith.run.type": run.run_type, "langsmith.run.id": run.id };
  }
}

export const langsmith: SourceAdapter = {
  name: "langsmith",
  description: "LangSmith runs via the runs/query API",
  requiredEnv: ["LANGSMITH_API_KEY"],
  optionalEnv: ["LANGSMITH_ENDPOINT (default https://api.smith.langchain.com)"],

  async fetch(ctx: AdapterContext): Promise<SourceFile[]> {
    const env = requireEnv(this, ctx.env);
    const endpoint = (ctx.env.LANGSMITH_ENDPOINT ?? "https://api.smith.langchain.com").replace(/\/$/, "");
    const files: SourceFile[] = [];
    let cursor: string | undefined;
    let page = 0;

    do {
      const res = await ctx.fetchImpl(`${endpoint}/api/v1/runs/query`, {
        method: "POST",
        headers: { "x-api-key": env.LANGSMITH_API_KEY!, "content-type": "application/json" },
        body: JSON.stringify({
          start_time: ctx.window.fromISO,
          end_time: ctx.window.toISO,
          limit: 100,
          ...(cursor ? { cursor } : {}),
        }),
      });
      if (!res.ok) {
        throw new SourceError(`LangSmith rejected the query (${res.status}). Check LANGSMITH_API_KEY.`);
      }
      const body = (await res.json()) as { runs?: LsRun[]; cursors?: { next?: string } };
      const runs = body.runs ?? [];
      const spans = runs.flatMap((run) => {
        if (!run.start_time) return [];
        return [
          otlpSpan({
            traceId: run.trace_id ? run.trace_id.replaceAll("-", "") : hexId(run.id, 16),
            spanId: hexId(run.id, 8),
            parentSpanId: run.parent_run_id ? hexId(run.parent_run_id, 8) : undefined,
            name: `${run.run_type ?? "run"} ${run.name ?? ""}`.trim(),
            startISO: run.start_time,
            endISO: run.end_time,
            attrs: runAttrs(run),
          }),
        ];
      });
      if (spans.length > 0) {
        files.push({
          name: `langsmith-${String(page).padStart(4, "0")}.json`,
          content: JSON.stringify(otlpDocument("langsmith-import", spans)),
        });
      }
      cursor = body.cursors?.next;
      page += 1;
      ctx.log(`langsmith: page ${page}, ${runs.length} runs`);
    } while (cursor);

    return files;
  },
};
