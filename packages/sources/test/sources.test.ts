import { createServer, type Server } from "node:http";
import { afterAll, describe, expect, it } from "vitest";
import { parseOtlpJson } from "../../normalize/src/otlp.js";
import { datadog, langfuse, langsmith, parseWindow, s3, tempo } from "../src/index.js";
import type { AdapterContext, SourceFile } from "../src/types.js";

/**
 * Each adapter runs against a local fake of its vendor API. The
 * assertions that matter: credentials go where the vendor expects them
 * and nowhere else, pagination is followed to the end, and the output
 * parses with the same OTLP parser the real pipeline uses.
 */

const servers: Server[] = [];
afterAll(() => servers.forEach((s) => s.close()));

function serve(handler: Parameters<typeof createServer>[1]): Promise<string> {
  const server = createServer(handler);
  servers.push(server);
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve(`http://127.0.0.1:${(server.address() as { port: number }).port}`);
    });
  });
}

const WINDOW = { fromISO: "2026-07-01T00:00:00.000Z", toISO: "2026-08-01T00:00:00.000Z" };

function ctx(env: Record<string, string>): AdapterContext {
  return { window: WINDOW, env, fetchImpl: fetch, log: () => {} };
}

function allSpans(files: SourceFile[]) {
  return files.flatMap((f) => parseOtlpJson(JSON.parse(f.content)));
}

describe("parseWindow", () => {
  it("parses rolling and month windows", () => {
    const now = new Date("2026-08-03T12:00:00.000Z");
    expect(parseWindow("last-30d", now).fromISO).toBe("2026-07-04T12:00:00.000Z");
    expect(parseWindow("2026-07", now)).toEqual(WINDOW);
    expect(parseWindow("last-month", now)).toEqual(WINDOW);
    expect(() => parseWindow("yesterday")).toThrow(/last-30d/);
  });
});

describe("datadog", () => {
  it("authenticates, paginates, and converts spans", async () => {
    const seen: unknown[] = [];
    const url = await serve((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        seen.push({ api: req.headers["dd-api-key"], app: req.headers["dd-application-key"] });
        const cursor = (JSON.parse(body) as { data: { attributes: { page: { cursor?: string } } } })
          .data.attributes.page.cursor;
        res.setHeader("content-type", "application/json");
        res.end(
          JSON.stringify(
            cursor
              ? { data: [], meta: {} }
              : {
                  data: [
                    {
                      id: "evt1",
                      attributes: {
                        trace_id: "aaaa000011112222",
                        span_id: "bbbb0001",
                        start_timestamp: "2026-07-10T10:00:00.000Z",
                        end_timestamp: "2026-07-10T10:00:01.000Z",
                        service: "claims-agent",
                        resource_name: "chat anthropic",
                        custom: {
                          gen_ai: { system: "anthropic", operation: { name: "chat" }, request: { model: "claude-sonnet-5" } },
                        },
                      },
                    },
                  ],
                  meta: { page: { after: "next-1" } },
                },
          ),
        );
      });
    });
    const files = await datadog.fetch({
      ...ctx({ DD_API_KEY: "k", DD_APP_KEY: "a", DD_SITE: "x" }),
      fetchImpl: ((input: string, init?: RequestInit) =>
        fetch(url + new URL(input).pathname, init)) as typeof fetch,
    });
    expect(seen).toHaveLength(2);
    expect(seen[0]).toEqual({ api: "k", app: "a" });
    const spans = allSpans(files);
    expect(spans).toHaveLength(1);
    expect(spans[0]!.attrs["gen_ai.system"]).toBe("anthropic");
    expect(spans[0]!.attrs["gen_ai.request.model"]).toBe("claude-sonnet-5");
  });
});

describe("langfuse", () => {
  it("uses basic auth and maps generations to gen_ai spans", async () => {
    let auth = "";
    const url = await serve((req, res) => {
      auth = req.headers.authorization ?? "";
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify({
          data: [
            {
              id: "obs-1",
              traceId: "cccc000011112222",
              type: "GENERATION",
              name: "chat claude",
              startTime: "2026-07-11T09:00:00.000Z",
              endTime: "2026-07-11T09:00:02.000Z",
              model: "claude-sonnet-5",
              usage: { input: 100, output: 40 },
              metadata: { ls_provider: "anthropic" },
            },
          ],
          meta: { totalPages: 1 },
        }),
      );
    });
    const files = await langfuse.fetch(
      ctx({ LANGFUSE_PUBLIC_KEY: "pk", LANGFUSE_SECRET_KEY: "sk", LANGFUSE_HOST: url }),
    );
    expect(auth).toBe(`Basic ${Buffer.from("pk:sk").toString("base64")}`);
    const spans = allSpans(files);
    expect(spans[0]!.attrs["gen_ai.operation.name"]).toBe("chat");
    expect(spans[0]!.attrs["gen_ai.usage.input_tokens"]).toBe(100);
  });
});

describe("langsmith", () => {
  it("maps llm, tool and root chain runs", async () => {
    let key = "";
    const url = await serve((req, res) => {
      key = String(req.headers["x-api-key"]);
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify({
          runs: [
            { id: "r1", trace_id: "dddd-0000-1111-2222", run_type: "llm", name: "claude", start_time: "2026-07-12T08:00:00.000Z", prompt_tokens: 10, completion_tokens: 5, extra: { invocation_params: { model: "claude-sonnet-5" }, metadata: { ls_provider: "anthropic" } } },
            { id: "r2", trace_id: "dddd-0000-1111-2222", parent_run_id: "r3", run_type: "tool", name: "lookup_policy", start_time: "2026-07-12T08:00:01.000Z" },
            { id: "r3", trace_id: "dddd-0000-1111-2222", run_type: "chain", name: "claims-agent", start_time: "2026-07-12T08:00:00.000Z" },
          ],
        }),
      );
    });
    const files = await langsmith.fetch(
      ctx({ LANGSMITH_API_KEY: "ls-key", LANGSMITH_ENDPOINT: url }),
    );
    expect(key).toBe("ls-key");
    const spans = allSpans(files);
    const ops = spans.map((s) => s.attrs["gen_ai.operation.name"]);
    expect(ops).toContain("chat");
    expect(ops).toContain("execute_tool");
    expect(ops).toContain("invoke_agent");
    expect(spans.find((s) => s.attrs["gen_ai.tool.name"])!.attrs["gen_ai.tool.name"]).toBe("lookup_policy");
  });
});

describe("tempo", () => {
  it("passes native OTLP through with the batches key renamed", async () => {
    const url = await serve((req, res) => {
      res.setHeader("content-type", "application/json");
      if (req.url!.startsWith("/api/search")) {
        res.end(JSON.stringify({ traces: [{ traceID: "eeee1111" }] }));
      } else {
        res.end(
          JSON.stringify({
            batches: [
              {
                resource: { attributes: [] },
                scopeSpans: [
                  {
                    spans: [
                      {
                        traceId: "eeee1111",
                        spanId: "ffff0001",
                        name: "invoke_agent claims",
                        startTimeUnixNano: "1783087200000000000",
                        endTimeUnixNano: "1783087201000000000",
                        attributes: [
                          { key: "gen_ai.operation.name", value: { stringValue: "invoke_agent" } },
                        ],
                      },
                    ],
                  },
                ],
              },
            ],
          }),
        );
      }
    });
    const files = await tempo.fetch(ctx({ TEMPO_URL: url }));
    const spans = allSpans(files);
    expect(spans[0]!.attrs["gen_ai.operation.name"]).toBe("invoke_agent");
  });
});

describe("s3", () => {
  it("signs with SigV4 and fetches archive objects", async () => {
    const auths: string[] = [];
    const doc = JSON.stringify({
      resourceSpans: [
        { scopeSpans: [{ spans: [{ traceId: "ab01", spanId: "cd02", name: "chat", startTimeUnixNano: "1783087200000000000", endTimeUnixNano: "1783087200000000000", attributes: [] }] }] },
      ],
    });
    const url = await serve((req, res) => {
      auths.push(String(req.headers.authorization));
      if (req.url!.includes("list-type=2")) {
        res.setHeader("content-type", "application/xml");
        res.end(
          `<ListBucketResult><Contents><Key>traces/2026-07-15.json</Key><LastModified>2026-07-15T01:00:00.000Z</LastModified></Contents></ListBucketResult>`,
        );
      } else {
        res.end(doc);
      }
    });
    const files = await s3.fetch(
      ctx({
        S3_BUCKET: "evidence",
        AWS_ACCESS_KEY_ID: "AKIATEST",
        AWS_SECRET_ACCESS_KEY: "secret",
        S3_ENDPOINT: url,
      }),
    );
    expect(auths.every((a) => a.startsWith("AWS4-HMAC-SHA256 Credential=AKIATEST/"))).toBe(true);
    expect(files).toHaveLength(1);
    expect(allSpans(files)).toHaveLength(1);
  });
});
