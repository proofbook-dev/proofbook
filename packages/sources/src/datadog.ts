import {
  otlpDocument,
  otlpSpan,
  requireEnv,
  SourceError,
  type AdapterContext,
  type SourceFile,
  type SourceAdapter,
} from "./types.js";

/**
 * Datadog source. Two stores, two APIs, one adapter.
 *
 * By default it reads LLM Observability spans (the agent telemetry
 * Proofbook exists to evaluate) and translates each into an OTLP span
 * carrying gen_ai.* / proofbook.* attributes, so everything downstream
 * maps them exactly as if the OTel GenAI instrumentation had emitted
 * them. Set DD_SPANS=apm to read the APM Spans index instead, for teams
 * who export OpenTelemetry to Datadog APM rather than using LLM Obs.
 *
 * The two products are separate: LLM Observability data is not in the
 * APM span index, and querying the wrong one returns "No valid indexes
 * specified" or nothing. This is why the default is LLM Obs.
 */

/* ---------------------------------------------------------------- */
/* Shared                                                            */
/* ---------------------------------------------------------------- */

function siteOf(env: Record<string, string | undefined>): string {
  return env.DD_SITE ?? "datadoghq.com";
}

function flatten(
  prefix: string,
  value: unknown,
  into: Record<string, string | number | boolean>,
): void {
  if (value === null || value === undefined) return;
  if (typeof value === "object" && !Array.isArray(value)) {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      flatten(prefix ? `${prefix}.${k}` : k, v, into);
    }
    return;
  }
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    into[prefix] = value;
  } else if (Array.isArray(value)) {
    into[prefix] = JSON.stringify(value);
  }
}

/* ---------------------------------------------------------------- */
/* LLM Observability (default)                                       */
/* ---------------------------------------------------------------- */

interface LlmObsSpan {
  id?: string;
  attributes?: {
    trace_id?: string;
    span_id?: string;
    parent_id?: string;
    name?: string;
    span_kind?: string;
    status?: string;
    start_ns?: number;
    duration?: number;
    ml_app?: string;
    model_name?: string;
    model_provider?: string;
    metrics?: Record<string, number>;
    metadata?: Record<string, unknown>;
    input?: { value?: unknown };
    output?: { value?: unknown };
    tags?: string[];
  };
}

/** Datadog "key:value" tag list → map. */
function tagMap(tags: string[] | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const t of tags ?? []) {
    const i = t.indexOf(":");
    if (i > 0) out[t.slice(0, i)] = t.slice(i + 1);
  }
  return out;
}

function nsToIso(ns: number | undefined): string {
  // Nanos exceed 2^53, but we only need millisecond precision; the lost
  // sub-microsecond digits never change the ISO string.
  return new Date((ns ?? 0) / 1e6).toISOString();
}

const asText = (v: unknown): string | undefined =>
  v === undefined || v === null ? undefined : typeof v === "string" ? v : JSON.stringify(v);

/**
 * One LLM Obs span → the gen_ai.* / proofbook.* attribute set the OTel
 * GenAI generation rules recognise. span_kind drives the mapping.
 */
function llmObsAttrs(a: NonNullable<LlmObsSpan["attributes"]>): Record<string, string | number | boolean> {
  const attrs: Record<string, string | number | boolean> = {};
  const tags = tagMap(a.tags);
  const meta = a.metadata ?? {};
  if (tags.service) attrs["service.name"] = tags.service;

  switch (a.span_kind) {
    case "agent": {
      attrs["gen_ai.operation.name"] = "invoke_agent";
      attrs["gen_ai.agent.id"] = String(meta.agent_id ?? a.name ?? "agent");
      if (a.name) attrs["gen_ai.agent.name"] = a.name;
      if (meta.session_id) attrs["session.id"] = String(meta.session_id);
      break;
    }
    case "llm": {
      attrs["gen_ai.operation.name"] = "chat";
      if (a.model_provider) attrs["gen_ai.system"] = a.model_provider;
      if (a.model_name) {
        attrs["gen_ai.request.model"] = a.model_name;
        attrs["gen_ai.response.model"] = a.model_name;
      }
      const m = a.metrics ?? {};
      if (typeof m.input_tokens === "number") attrs["gen_ai.usage.input_tokens"] = m.input_tokens;
      if (typeof m.output_tokens === "number") attrs["gen_ai.usage.output_tokens"] = m.output_tokens;
      const prompt = asText(a.input?.value);
      const completion = asText(a.output?.value);
      if (prompt) attrs["gen_ai.prompt"] = prompt;
      if (completion) attrs["gen_ai.completion"] = completion;
      break;
    }
    case "tool": {
      attrs["gen_ai.operation.name"] = "execute_tool";
      if (a.name) attrs["gen_ai.tool.name"] = a.name;
      const args = asText(a.input?.value);
      const result = asText(a.output?.value);
      if (args) attrs["gen_ai.tool.call.arguments"] = args;
      if (result) attrs["gen_ai.tool.call.result"] = result;
      break;
    }
    default: {
      // task / workflow: a human checkpoint if it is tagged as one.
      if (tags.human_checkpoint === "true" || meta.checkpoint_type) {
        attrs["proofbook.human_checkpoint.type"] = String(meta.checkpoint_type ?? "approval");
        if (meta.decision) attrs["proofbook.human_checkpoint.decision"] = String(meta.decision);
        if (meta.actor) attrs["proofbook.human_checkpoint.actor"] = String(meta.actor);
      }
    }
  }
  return attrs;
}

async function fetchLlmObs(ctx: AdapterContext, env: Record<string, string>): Promise<SourceFile[]> {
  const site = siteOf(ctx.env);
  const files: SourceFile[] = [];
  let cursor: string | undefined;
  let page = 0;

  do {
    const res = await ctx.fetchImpl(`https://api.${site}/api/v2/llm-obs/v1/spans/events/search`, {
      method: "POST",
      headers: {
        "DD-API-KEY": env.DD_API_KEY!,
        "DD-APPLICATION-KEY": env.DD_APP_KEY!,
        "content-type": "application/vnd.api+json",
      },
      body: JSON.stringify({
        data: {
          type: "spans",
          attributes: {
            filter: {
              from: ctx.window.fromISO,
              to: ctx.window.toISO,
              query: ctx.env.DD_QUERY ?? "*",
            },
            page: { limit: 1000, ...(cursor ? { cursor } : {}) },
          },
        },
      }),
    });
    if (!res.ok) {
      const detail = (await res.text().catch(() => "")).slice(0, 500);
      throw new SourceError(
        `Datadog rejected the LLM Observability search (${res.status}) at api.${site}. ` +
          (detail ? `Datadog said: ${detail} ` : "") +
          `Check DD_APP_KEY has the llm_observability_read permission and DD_SITE matches ` +
          `your region (EU = datadoghq.eu).`,
      );
    }
    const body = (await res.json()) as {
      data?: LlmObsSpan[];
      meta?: { page?: { after?: string } };
    };
    const spans = (body.data ?? []).flatMap((s) => {
      const a = s.attributes;
      if (!a?.trace_id || a.start_ns === undefined) return [];
      const span = otlpSpan({
        traceId: a.trace_id,
        spanId: a.span_id ?? s.id ?? a.trace_id,
        parentSpanId:
          a.parent_id && a.parent_id !== "0" && a.parent_id !== "undefined" ? a.parent_id : undefined,
        name: a.name ?? a.span_kind ?? "span",
        startISO: nsToIso(a.start_ns),
        endISO: nsToIso((a.start_ns ?? 0) + (a.duration ?? 0)),
        attrs: llmObsAttrs(a),
      });
      // Errors drive the anomaly controls; carry Datadog's error status
      // through as an OTLP error so they are derived, not lost.
      if (a.status === "error") {
        (span as Record<string, unknown>).status = { code: 2, message: `${a.name ?? "span"} failed` };
      }
      return [span];
    });
    if (spans.length > 0) {
      files.push({
        name: `datadog-llmobs-${String(page).padStart(4, "0")}.json`,
        content: JSON.stringify(otlpDocument("datadog-llm-obs", spans)),
      });
    }
    cursor = body.meta?.page?.after;
    page += 1;
    ctx.log(`datadog (llm-obs): page ${page}, ${spans.length} spans`);
  } while (cursor);

  return files;
}

/* ---------------------------------------------------------------- */
/* APM spans (DD_SPANS=apm)                                          */
/* ---------------------------------------------------------------- */

interface DdSpan {
  id?: string;
  attributes?: {
    trace_id?: string;
    span_id?: string;
    parent_id?: string;
    start_timestamp?: string;
    end_timestamp?: string;
    resource_name?: string;
    operation_name?: string;
    service?: string;
    custom?: Record<string, unknown>;
  };
}

async function fetchApm(ctx: AdapterContext, env: Record<string, string>): Promise<SourceFile[]> {
  const site = siteOf(ctx.env);
  const files: SourceFile[] = [];
  let cursor: string | undefined;
  let page = 0;

  do {
    const res = await ctx.fetchImpl(`https://api.${site}/api/v2/spans/events/search`, {
      method: "POST",
      headers: {
        "DD-API-KEY": env.DD_API_KEY!,
        "DD-APPLICATION-KEY": env.DD_APP_KEY!,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        data: {
          type: "search_request",
          attributes: {
            filter: { from: ctx.window.fromISO, to: ctx.window.toISO, query: ctx.env.DD_QUERY ?? "*" },
            page: { limit: 1000, ...(cursor ? { cursor } : {}) },
            sort: "timestamp",
          },
        },
      }),
    });
    if (!res.ok) {
      const detail = (await res.text().catch(() => "")).slice(0, 500);
      throw new SourceError(
        `Datadog rejected the spans search (${res.status}) at api.${site}. ` +
          (detail ? `Datadog said: ${detail} ` : "") +
          `"No valid indexes specified" means this org has no indexed APM spans; ` +
          `LLM Observability data lives elsewhere, so drop DD_SPANS=apm to read it.`,
      );
    }
    const body = (await res.json()) as { data?: DdSpan[]; meta?: { page?: { after?: string } } };
    const spans = (body.data ?? []).flatMap((s) => {
      const a = s.attributes;
      if (!a?.trace_id || !a.start_timestamp) return [];
      const attrs: Record<string, string | number | boolean> = {};
      flatten("", a.custom ?? {}, attrs);
      if (a.service) attrs["service.name"] = a.service;
      return [
        otlpSpan({
          traceId: a.trace_id,
          spanId: a.span_id ?? s.id ?? a.trace_id,
          parentSpanId: a.parent_id,
          name: a.resource_name ?? a.operation_name ?? "span",
          startISO: a.start_timestamp,
          endISO: a.end_timestamp,
          attrs,
        }),
      ];
    });
    if (spans.length > 0) {
      files.push({
        name: `datadog-apm-${String(page).padStart(4, "0")}.json`,
        content: JSON.stringify(otlpDocument("datadog-apm", spans)),
      });
    }
    cursor = body.meta?.page?.after;
    page += 1;
    ctx.log(`datadog (apm): page ${page}, ${spans.length} spans`);
  } while (cursor);

  return files;
}

/* ---------------------------------------------------------------- */

export const datadog: SourceAdapter = {
  name: "datadog",
  description: "Datadog LLM Observability spans (or APM spans with DD_SPANS=apm)",
  requiredEnv: ["DD_API_KEY", "DD_APP_KEY"],
  optionalEnv: [
    "DD_SITE (default datadoghq.com)",
    "DD_QUERY (default *)",
    "DD_SPANS (llmobs default, or apm)",
  ],

  async fetch(ctx: AdapterContext): Promise<SourceFile[]> {
    const env = requireEnv(this, ctx.env);
    return (ctx.env.DD_SPANS ?? "llmobs").toLowerCase() === "apm"
      ? fetchApm(ctx, env)
      : fetchLlmObs(ctx, env);
  },
};
