import {
  otlpDocument,
  otlpSpan,
  requireEnv,
  SourceError,
  type AdapterContext,
  type SourceAdapter,
  type SourceFile,
} from "./types.js";

/**
 * Datadog Spans API (v2 search). Works for APM spans and LLM
 * Observability spans alike: whatever attributes Datadog stored are
 * flattened onto the OTLP span untouched, so gen_ai.* attributes set
 * by instrumentation survive the round trip and the generation
 * detector sees them exactly as emitted.
 */

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

function flatten(prefix: string, value: unknown, into: Record<string, string | number | boolean>): void {
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

export const datadog: SourceAdapter = {
  name: "datadog",
  description: "Datadog APM / LLM Observability spans via the v2 Spans API",
  requiredEnv: ["DD_API_KEY", "DD_APP_KEY"],
  optionalEnv: ["DD_SITE (default datadoghq.com)", "DD_QUERY (default *)"],

  async fetch(ctx: AdapterContext): Promise<SourceFile[]> {
    const env = requireEnv(this, ctx.env);
    const site = ctx.env.DD_SITE ?? "datadoghq.com";
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
              filter: {
                from: ctx.window.fromISO,
                to: ctx.window.toISO,
                query: ctx.env.DD_QUERY ?? "*",
              },
              page: { limit: 1000, ...(cursor ? { cursor } : {}) },
              sort: "timestamp",
            },
          },
        }),
      });
      if (!res.ok) {
        throw new SourceError(
          `Datadog rejected the spans search (${res.status}). Check the keys have ` +
            `apm_read scope and DD_SITE matches your account region.`,
        );
      }
      const body = (await res.json()) as {
        data?: DdSpan[];
        meta?: { page?: { after?: string } };
      };
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
          name: `datadog-${String(page).padStart(4, "0")}.json`,
          content: JSON.stringify(otlpDocument("datadog-import", spans)),
        });
      }
      cursor = body.meta?.page?.after;
      page += 1;
      ctx.log(`datadog: page ${page}, ${spans.length} spans`);
    } while (cursor);

    return files;
  },
};
