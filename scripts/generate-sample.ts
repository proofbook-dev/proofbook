/**
 * Generate a realistic sample of agent telemetry as OTLP JSONL, the
 * format the OTel collector file exporter writes.
 *
 * Deliberately imperfect, because real telemetry is: a service that
 * emits chat spans with no provider attribute, a workflow with no
 * human approvals, a slice of model calls without content capture, a
 * background job whose traces carry no agent span at all, occasional
 * rate limits, and some plain database spans no GenAI rule will claim.
 *
 * Deterministic for a given seed; timestamps span the last N days.
 *
 *   pnpm dlx tsx scripts/generate-sample.ts [--traces 150] [--days 30] [--seed 42]
 */
import { mkdir } from "node:fs/promises";
import { createWriteStream } from "node:fs";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function arg(name: string, fallback: number): number {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 && process.argv[i + 1] ? Number(process.argv[i + 1]) : fallback;
}
const TRACES = arg("traces", 150);
const DAYS = arg("days", 30);
const SEED = arg("seed", 42);

// mulberry32: tiny seeded PRNG, good enough for sample data.
function prng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = prng(SEED);
const pick = <T,>(xs: T[]): T => xs[Math.floor(rand() * xs.length)]!;
const between = (lo: number, hi: number) => lo + rand() * (hi - lo);
const hex = (n: number) => Array.from({ length: n }, () => "0123456789abcdef"[Math.floor(rand() * 16)]).join("");

const str = (v: string) => ({ stringValue: v });
const int = (v: number) => ({ intValue: String(Math.round(v)) });
const dbl = (v: number) => ({ doubleValue: v });
const kv = (key: string, value: unknown) => ({ key, value });

interface SpanSpec {
  spanId: string; parentSpanId?: string; name: string; kind: number;
  start: number; end: number; attrs: ReturnType<typeof kv>[];
  status?: { code: number; message?: string }; events?: unknown[];
}

const AGENTS = [
  { id: "claims-triage", weight: 0.5, approvals: false, service: "claims-agent-runtime" },
  { id: "payout-release", weight: 0.25, approvals: true, service: "claims-agent-runtime" },
  { id: "claims-intake", weight: 0.25, approvals: false, service: "intake-service" },
];
const MODELS = [
  { provider: "anthropic", model: "claude-sonnet-4-6", weight: 0.7 },
  { provider: "openai", model: "gpt-4o-mini", weight: 0.3 },
];
const TOOLS = ["lookup_policy", "update_claim", "send_email", "release_payout"];
const PROMPTS = [
  "Triage this claim: policy P-%d, water damage, kitchen.",
  "Assess payout eligibility for claim C-%d against policy terms.",
  "Summarise intake notes for claim C-%d and classify severity.",
];
const REVIEWERS = ["reviewer:m.keane@acme.example", "reviewer:s.obrien@acme.example"];

function weighted<T extends { weight: number }>(xs: T[]): T {
  let r = rand();
  for (const x of xs) { if ((r -= x.weight) <= 0) return x; }
  return xs.at(-1)!;
}

function makeTrace(endMs: number): { service: string; spans: SpanSpec[] } {
  const agent = weighted(AGENTS);
  const kind = rand();
  // 4%: background job traces with model calls but no agent span at all.
  const headless = kind < 0.04;
  // 5%: a service whose emitter never sets gen_ai.system (unmappable calls).
  const unattributedProvider = kind >= 0.04 && kind < 0.09;

  const spans: SpanSpec[] = [];
  const t0 = endMs - between(5_000, 90_000);
  let cursor = t0;
  const rootId = hex(16);

  if (!headless) {
    spans.push({
      spanId: rootId, name: `invoke_agent ${agent.id}`, kind: 1,
      start: t0, end: 0, // patched at the end
      attrs: [
        kv("gen_ai.operation.name", str("invoke_agent")),
        kv("gen_ai.agent.id", str(agent.id)),
        kv("gen_ai.agent.name", str(agent.id.replace(/-/g, " "))),
        kv("gen_ai.conversation.id", str(`sess-${Math.floor(rand() * 9000) + 1000}`)),
      ],
      status: { code: 1 },
    });
  }

  const modelCalls = 1 + Math.floor(rand() * 3);
  for (let i = 0; i < modelCalls; i += 1) {
    const m = weighted(MODELS);
    const start = cursor += between(200, 1500);
    const latency = between(600, 4200);
    const failed = rand() < 0.04;
    const captureContent = rand() < 0.85;
    const claim = Math.floor(rand() * 90000) + 10000;
    const attrs = [
      kv("gen_ai.operation.name", str("chat")),
      ...(unattributedProvider ? [] : [kv("gen_ai.system", str(m.provider))]),
      kv("gen_ai.request.model", str(m.model)),
      kv("gen_ai.response.model", str(m.model)),
      kv("gen_ai.request.temperature", dbl(0.2)),
      kv("gen_ai.usage.input_tokens", int(between(300, 2600))),
      kv("gen_ai.usage.output_tokens", int(between(40, 700))),
      kv("gen_ai.response.finish_reasons", { arrayValue: { values: [str(failed ? "error" : "end_turn")] } }),
      ...(captureContent
        ? [
            kv("gen_ai.prompt", str(pick(PROMPTS).replace("%d", String(claim)))),
            kv("gen_ai.completion", str(`Assessment complete for ${claim}. Routed per policy.`)),
          ]
        : []),
    ];
    spans.push({
      spanId: hex(16), ...(headless ? {} : { parentSpanId: rootId }),
      name: `chat ${m.model}`, kind: 3, start, end: start + latency, attrs,
      ...(failed
        ? {
            status: { code: 2, message: "rate limited" },
            events: [{
              name: "exception", timeUnixNano: String(Math.round((start + latency) * 1e6)),
              attributes: [kv("exception.type", str("RateLimitError"))],
            }],
          }
        : { status: { code: 1 } }),
    });
    cursor = start + latency;
  }

  const toolCalls = Math.floor(rand() * 3);
  for (let i = 0; i < toolCalls && !headless; i += 1) {
    const tool = agent.id === "payout-release" && i === 0 ? "release_payout" : pick(TOOLS);
    if (tool === "release_payout" && agent.approvals) {
      const at = cursor += between(300, 2000);
      spans.push({
        spanId: hex(16), parentSpanId: rootId, name: "human_approval payout-release", kind: 1,
        start: at, end: at + between(40, 400),
        attrs: [
          kv("proofbook.human_checkpoint.type", str("approval")),
          kv("proofbook.human_checkpoint.decision", str(rand() < 0.93 ? "approved" : "rejected")),
          kv("proofbook.human_checkpoint.actor", str(pick(REVIEWERS))),
        ],
        status: { code: 1 },
      });
      cursor = at + 500;
    }
    const start = cursor += between(100, 900);
    const failed = rand() < 0.05;
    spans.push({
      spanId: hex(16), parentSpanId: rootId, name: `execute_tool ${tool}`, kind: 1,
      start, end: start + between(80, 2500),
      attrs: [
        kv("gen_ai.operation.name", str("execute_tool")),
        kv("gen_ai.tool.name", str(tool)),
        kv("mcp.server.name", str("claims-mcp")),
        kv("gen_ai.tool.call.arguments", str(`{"claim":"C-${Math.floor(rand() * 90000)}"}`)),
      ],
      status: failed ? { code: 2, message: "upstream timeout" } : { code: 1 },
    });
    cursor = start + 600;
  }

  // Plain infrastructure spans that no GenAI rule should claim.
  if (rand() < 0.3) {
    const start = cursor += between(50, 300);
    spans.push({
      spanId: hex(16), ...(headless ? {} : { parentSpanId: rootId }),
      name: "SELECT claims", kind: 3, start, end: start + between(2, 40),
      attrs: [kv("db.system.name", str("postgresql"))],
      status: { code: 1 },
    });
  }

  const last = Math.max(...spans.map((s) => s.end));
  if (!headless) spans[0]!.end = last + between(100, 800);
  return { service: headless ? "svc-batch" : agent.service, spans };
}

const now = Date.now();
await mkdir(join(root, "tmp"), { recursive: true });
const out = join(root, "tmp", "sample-traces.jsonl");
// Stream each trace as it is generated: accumulating millions of
// lines (or joining them) is an OOM at realistic volumes.
const stream = createWriteStream(out);
let bytes = 0;
for (let i = 0; i < TRACES; i += 1) {
  const endMs = now - rand() * DAYS * 86_400_000;
  const { service, spans } = makeTrace(endMs);
  const traceId = hex(32);
  const line = JSON.stringify({
      resourceSpans: [{
        resource: {
          attributes: [
            kv("service.name", str(service)),
            kv("deployment.environment.name", str("production")),
          ],
        },
        scopeSpans: [{
          scope: { name: "@proofbook/instrument", version: "0.1.0" },
          spans: spans.map((s) => ({
            traceId,
            spanId: s.spanId,
            ...(s.parentSpanId ? { parentSpanId: s.parentSpanId } : {}),
            name: s.name,
            kind: s.kind,
            startTimeUnixNano: String(Math.round(s.start * 1e6)),
            endTimeUnixNano: String(Math.round(s.end * 1e6)),
            attributes: s.attrs,
            ...(s.status ? { status: s.status } : {}),
            ...(s.events ? { events: s.events } : {}),
          })),
        }],
      }],
    });
  bytes += line.length + 1;
  if (!stream.write(line + "\n")) await once(stream, "drain");
}

stream.end();
await once(stream, "finish");
console.log(`wrote ${TRACES} traces (${bytes.toLocaleString("en-US")} bytes): ${out}`);
