/**
 * OTLP JSON parsing.
 *
 * Accepts ExportTraceServiceRequest JSON as written by the OTel collector
 * file exporter and most SDK JSON exporters. Field names appear in the
 * wild in both proto3-JSON camelCase and snake_case; both are accepted.
 *
 * The output is a flat list of ParsedSpan with decoded attributes. No
 * interpretation happens here; that is the rule set's job.
 */

export interface ParsedSpanEvent {
  name: string;
  timeNano: bigint;
  attrs: Record<string, unknown>;
}

export interface ParsedSpan {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  startNano: bigint;
  endNano: bigint;
  attrs: Record<string, unknown>;
  resourceAttrs: Record<string, unknown>;
  scopeName?: string;
  statusCode: "UNSET" | "OK" | "ERROR";
  statusMessage?: string;
  events: ParsedSpanEvent[];
}

type Json = Record<string, unknown>;

function field(obj: Json, camel: string, snake: string): unknown {
  return obj[camel] !== undefined ? obj[camel] : obj[snake];
}

function decodeAnyValue(v: unknown): unknown {
  if (v === null || typeof v !== "object") return v;
  const val = v as Json;
  if (val.stringValue !== undefined || val.string_value !== undefined)
    return field(val, "stringValue", "string_value");
  if (val.intValue !== undefined || val.int_value !== undefined)
    return Number(field(val, "intValue", "int_value"));
  if (val.doubleValue !== undefined || val.double_value !== undefined)
    return Number(field(val, "doubleValue", "double_value"));
  if (val.boolValue !== undefined || val.bool_value !== undefined)
    return Boolean(field(val, "boolValue", "bool_value"));
  const arr = field(val, "arrayValue", "array_value") as Json | undefined;
  if (arr) return ((arr.values as unknown[]) ?? []).map(decodeAnyValue);
  const kv = field(val, "kvlistValue", "kvlist_value") as Json | undefined;
  if (kv) return decodeAttrs((kv.values as Json[]) ?? []);
  return undefined;
}

function decodeAttrs(list: Json[] | undefined): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const item of list ?? []) {
    const key = item.key as string | undefined;
    if (!key) continue;
    out[key] = decodeAnyValue(item.value);
  }
  return out;
}

function decodeStatus(status: Json | undefined): {
  code: ParsedSpan["statusCode"];
  message?: string;
} {
  if (!status) return { code: "UNSET" };
  const raw = status.code;
  let code: ParsedSpan["statusCode"] = "UNSET";
  if (raw === 1 || raw === "STATUS_CODE_OK") code = "OK";
  else if (raw === 2 || raw === "STATUS_CODE_ERROR") code = "ERROR";
  const message = typeof status.message === "string" ? status.message : undefined;
  return message !== undefined ? { code, message } : { code };
}

function nano(v: unknown): bigint {
  if (typeof v === "bigint") return v;
  if (typeof v === "number") return BigInt(Math.round(v));
  if (typeof v === "string" && v !== "") return BigInt(v);
  return 0n;
}

export function nanoToIso(n: bigint): string {
  return new Date(Number(n / 1_000_000n)).toISOString();
}

export class OtlpParseError extends Error {}

/** Parse one ExportTraceServiceRequest JSON document into flat spans. */
export function parseOtlpJson(doc: unknown): ParsedSpan[] {
  if (doc === null || typeof doc !== "object") {
    throw new OtlpParseError("input is not a JSON object");
  }
  const root = doc as Json;
  const resourceSpans = field(root, "resourceSpans", "resource_spans") as Json[] | undefined;
  if (!Array.isArray(resourceSpans)) {
    throw new OtlpParseError(
      "no resourceSpans found; expected OTLP ExportTraceServiceRequest JSON",
    );
  }

  const spans: ParsedSpan[] = [];
  for (const rs of resourceSpans) {
    const resource = field(rs, "resource", "resource") as Json | undefined;
    const resourceAttrs = decodeAttrs(resource?.attributes as Json[] | undefined);
    const scopeSpans = (field(rs, "scopeSpans", "scope_spans") as Json[] | undefined) ?? [];
    for (const ss of scopeSpans) {
      const scope = ss.scope as Json | undefined;
      const scopeName = typeof scope?.name === "string" ? scope.name : undefined;
      for (const raw of (ss.spans as Json[] | undefined) ?? []) {
        const status = decodeStatus(raw.status as Json | undefined);
        const parentSpanId = field(raw, "parentSpanId", "parent_span_id") as string | undefined;
        const events: ParsedSpanEvent[] = (((raw.events as Json[] | undefined) ?? []).map((e) => ({
          name: (e.name as string) ?? "",
          timeNano: nano(field(e, "timeUnixNano", "time_unix_nano")),
          attrs: decodeAttrs(e.attributes as Json[] | undefined),
        })));
        spans.push({
          traceId: String(field(raw, "traceId", "trace_id") ?? ""),
          spanId: String(field(raw, "spanId", "span_id") ?? ""),
          ...(parentSpanId ? { parentSpanId } : {}),
          name: String(raw.name ?? ""),
          startNano: nano(field(raw, "startTimeUnixNano", "start_time_unix_nano")),
          endNano: nano(field(raw, "endTimeUnixNano", "end_time_unix_nano")),
          attrs: decodeAttrs(raw.attributes as Json[] | undefined),
          resourceAttrs,
          ...(scopeName !== undefined ? { scopeName } : {}),
          statusCode: status.code,
          ...(status.message !== undefined ? { statusMessage: status.message } : {}),
          events,
        });
      }
    }
  }

  // Deterministic order regardless of export batching: time, then span id.
  spans.sort((a, b) =>
    a.startNano < b.startNano ? -1 : a.startNano > b.startNano ? 1 : a.spanId < b.spanId ? -1 : 1,
  );
  return spans;
}
