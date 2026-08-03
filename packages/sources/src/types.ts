/**
 * Trace-source adapters: the traces are not in the repo.
 *
 * Each adapter takes a time window and read-only credentials from the
 * environment and returns OTLP JSON documents, the same shape the OTel
 * collector file exporter writes, so everything downstream (generation
 * detection, normalisation, evaluation) is identical no matter where
 * the spans came from. Credentials are read here and go nowhere else:
 * never into files, never into bundles, never into logs.
 */

export interface Window {
  fromISO: string;
  toISO: string;
}

export interface SourceFile {
  /** Suggested file name, e.g. datadog-0001.json */
  name: string;
  /** OTLP JSON (ExportTraceServiceRequest) or JSONL of the same. */
  content: string;
}

export interface AdapterContext {
  window: Window;
  env: Record<string, string | undefined>;
  fetchImpl: typeof fetch;
  log: (message: string) => void;
}

export interface SourceAdapter {
  name: string;
  description: string;
  requiredEnv: string[];
  optionalEnv: string[];
  fetch(ctx: AdapterContext): Promise<SourceFile[]>;
}

export class SourceError extends Error {}

export function requireEnv(
  adapter: SourceAdapter,
  env: Record<string, string | undefined>,
): Record<string, string> {
  const missing = adapter.requiredEnv.filter((k) => !env[k]);
  if (missing.length > 0) {
    throw new SourceError(
      `${adapter.name} needs ${missing.join(", ")} in the environment. ` +
        `Read-only credentials are enough; they are used for this fetch and stored nowhere.`,
    );
  }
  return Object.fromEntries(adapter.requiredEnv.map((k) => [k, env[k]!]));
}

/** ISO time → OTLP unix nanos (string, as proto3 JSON renders int64). */
export function isoToNanoString(iso: string): string {
  return `${new Date(iso).getTime()}000000`;
}

interface OtlpSpanInput {
  traceId: string;
  spanId: string;
  parentSpanId?: string | undefined;
  name: string;
  startISO: string;
  endISO?: string | undefined;
  attrs: Record<string, string | number | boolean | undefined>;
}

/** Build one OTLP JSON span with typed attribute encoding. */
export function otlpSpan(input: OtlpSpanInput): Record<string, unknown> {
  const attributes = Object.entries(input.attrs)
    .filter(([, v]) => v !== undefined && v !== null && v !== "")
    .map(([key, v]) => ({
      key,
      value:
        typeof v === "number"
          ? Number.isInteger(v)
            ? { intValue: String(v) }
            : { doubleValue: v }
          : typeof v === "boolean"
            ? { boolValue: v }
            : { stringValue: String(v) },
    }));
  return {
    traceId: input.traceId,
    spanId: input.spanId,
    ...(input.parentSpanId ? { parentSpanId: input.parentSpanId } : {}),
    name: input.name,
    startTimeUnixNano: isoToNanoString(input.startISO),
    endTimeUnixNano: isoToNanoString(input.endISO ?? input.startISO),
    attributes,
  };
}

/** Wrap spans in an ExportTraceServiceRequest with a named resource. */
export function otlpDocument(
  serviceName: string,
  spans: Record<string, unknown>[],
): Record<string, unknown> {
  return {
    resourceSpans: [
      {
        resource: {
          attributes: [{ key: "service.name", value: { stringValue: serviceName } }],
        },
        scopeSpans: [{ scope: { name: "proofbook-source-adapter" }, spans }],
      },
    ],
  };
}

/** Deterministic hex id when a source lacks one (never random). */
export function hexId(seed: string, bytes: number): string {
  let h = 0x811c9dc5;
  let out = "";
  for (let round = 0; out.length < bytes * 2; round += 1) {
    for (const ch of `${round}:${seed}`) {
      h ^= ch.charCodeAt(0);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    out += h.toString(16).padStart(8, "0");
  }
  return out.slice(0, bytes * 2);
}

/**
 * The retention wall. Vendors delete traces on schedules much shorter
 * than audit periods, which makes sealing time-critical: evidence can
 * only be produced inside the window, and everything before it is
 * unrecoverable. Backfill is impossible by design and the product
 * never implies otherwise. Figures are vendor defaults; plans vary.
 */
export const RETENTION: Record<string, { days: number; note: string } | null> = {
  datadog: { days: 15, note: "15 days by default; 90 with the retention add-on" },
  langfuse: { days: 90, note: "90 days on Core; longer on paid plans" },
  langsmith: { days: 14, note: "14 days base retention; 400 days extended" },
  tempo: { days: 30, note: "configured per installation; 30 days is a common default" },
  s3: null,
};
