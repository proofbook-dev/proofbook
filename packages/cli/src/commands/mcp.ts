import { createInterface } from "node:readline";
import { loadCrosswalkDir } from "@proofbook/crosswalk";
import { discoverTraces } from "../discover.js";
import { runPipeline, type PipelineResult } from "../pipeline.js";
import { capabilityImpacts, CAPABILITY_TOPIC } from "../transcript.js";
import { TOPICS } from "./explain.js";

/**
 * `proof mcp`: a read-only MCP server over stdio, so a coding agent can
 * ask what evidence is missing and open the PR that instruments it.
 *
 * The protocol surface is deliberately tiny (initialize, tools/list,
 * tools/call over newline-delimited JSON-RPC), which is why this is
 * hand-rolled rather than a dependency. Nothing here mutates anything:
 * no sealing, no pushing, no writes.
 */

interface McpTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  handler: (args: Record<string, unknown>) => Promise<unknown>;
}

export function buildMcpTools(cwd: string, frameworks?: string[]): McpTool[] {
  // Traces are evaluated once per process and reused; a coding agent
  // asking five questions should not pay for five pipeline runs.
  let cached: Promise<PipelineResult | null> | undefined;
  const evaluate = () =>
    (cached ??= (async () => {
      const paths = await discoverTraces(cwd);
      if (paths.length === 0) return null;
      return runPipeline(paths, frameworks);
    })());

  return [
    {
      name: "list_controls",
      description:
        "List every compliance control in the loaded crosswalk (EU AI Act, ISO/IEC 42001, NIST AI RMF): id, article, title, and the capabilities its observed assertions depend on.",
      inputSchema: {
        type: "object",
        properties: {
          framework: { type: "string", description: "Optional framework filter, e.g. eu-ai-act" },
        },
      },
      handler: async (args) => {
        const crosswalks = await loadCrosswalkDir();
        const controls = [];
        for (const [name, cw] of crosswalks) {
          if (args.framework && args.framework !== name) continue;
          for (const c of cw.doc.controls) {
            controls.push({
              framework: name,
              control_id: c.id,
              article: c.article,
              title: c.title,
              requirement_summary: c.requirement_summary,
              capabilities: [
                ...new Set(
                  c.assertions
                    .filter((a) => a.source_class === "observed" && a.capability)
                    .map((a) => a.capability),
                ),
              ],
            });
          }
        }
        return { controls };
      },
    },
    {
      name: "get_verdict",
      description:
        "Evaluate local traces and return the verdict for one control: evidenced, partially_evidenced, not_evidenced, contradicted or unevaluable, with per-assertion results.",
      inputSchema: {
        type: "object",
        properties: { control_id: { type: "string" } },
        required: ["control_id"],
      },
      handler: async (args) => {
        const result = await evaluate();
        if (!result) return { error: "no trace files found; run the agent with OTel export first" };
        for (const ev of result.evaluations) {
          const control = ev.controls.find((c) => c.control_id === args.control_id);
          if (control) {
            return {
              framework: ev.framework,
              control_id: control.control_id,
              article: control.article,
              title: control.title,
              verdict: control.verdict,
              assertions: control.assertions.map((a) => ({
                assertion_id: a.assertion_id,
                description: a.description,
                source_class: a.source_class,
                verdict: a.verdict,
                unevaluable_reason: a.unevaluable_reason,
                derivation: a.derivation,
              })),
            };
          }
        }
        return { error: `unknown control_id ${String(args.control_id)}; call list_controls first` };
      },
    },
    {
      name: "explain_derivation",
      description:
        "For one control, explain exactly how its verdict was derived: each assertion's expression, source class, and the event counts it consulted. This is what an auditor reads.",
      inputSchema: {
        type: "object",
        properties: { control_id: { type: "string" } },
        required: ["control_id"],
      },
      handler: async (args) => {
        const result = await evaluate();
        if (!result) return { error: "no trace files found" };
        const crosswalks = [...result.frameworks.values()];
        const declared = crosswalks
          .flatMap((cw) => cw.doc.controls)
          .find((c) => c.id === args.control_id);
        for (const ev of result.evaluations) {
          const control = ev.controls.find((c) => c.control_id === args.control_id);
          if (control && declared) {
            return {
              control_id: control.control_id,
              verdict: control.verdict,
              assertions: control.assertions.map((a) => {
                const spec = declared.assertions.find((s) => s.id === a.assertion_id);
                return {
                  assertion_id: a.assertion_id,
                  description: a.description,
                  expression: spec?.expression,
                  source_class: a.source_class,
                  capability: spec?.capability,
                  verdict: a.verdict,
                  unevaluable_reason: a.unevaluable_reason,
                  derivation: a.derivation,
                };
              }),
            };
          }
        }
        return { error: `unknown control_id ${String(args.control_id)}` };
      },
    },
    {
      name: "get_coverage_gaps",
      description:
        "Evaluate local traces and return every capability the telemetry is missing or degraded on, how many controls each gap makes unevaluable, and the exact instrumentation (attribute names, code) that closes it.",
      inputSchema: { type: "object", properties: {} },
      handler: async () => {
        const result = await evaluate();
        if (!result) return { error: "no trace files found" };
        const impacts = capabilityImpacts(result.batch, [...result.frameworks.values()]);
        return {
          gaps: impacts
            .filter((i) => i.status !== "available")
            .map((i) => {
              const topicKey = CAPABILITY_TOPIC[i.capability];
              const topic = topicKey ? TOPICS[topicKey] : undefined;
              return {
                capability: i.capability,
                status: i.status,
                reason: i.reason,
                controls_affected: i.affected,
                fix: topic ? { what: topic.what, how: topic.how.join("\n") } : undefined,
              };
            }),
        };
      },
    },
  ];
}

interface RpcMessage {
  jsonrpc: "2.0";
  id?: number | string | null;
  method?: string;
  params?: Record<string, unknown>;
}

export async function mcpCommand(opts: {
  cwd: string;
  subject?: string | undefined;
  frameworks?: string[] | undefined;
}): Promise<number> {
  const tools = buildMcpTools(opts.cwd, opts.frameworks);
  const write = (msg: unknown) => process.stdout.write(`${JSON.stringify(msg)}\n`);

  // stdout belongs to the protocol; anything said to a human goes to
  // stderr. Run from a terminal rather than a client, silence reads as
  // a hang, so say what is actually happening and how to wire it up.
  if (process.stdin.isTTY) {
    process.stderr.write(
      [
        `proofbook mcp: serving ${tools.length} read-only tools over stdio, waiting for an MCP client.`,
        "Nothing is stuck; this command speaks JSON-RPC on stdin/stdout and is not meant to be run by hand.",
        "",
        "Wire it into a client instead:",
        "  claude mcp add proofbook -- npx -y proofbook mcp",
        '  (any MCP client: command "npx", args ["-y", "proofbook", "mcp"])',
        "",
        "Remote clients (ChatGPT connectors, hosted agents) use the portal endpoint",
        "over your pushed bundles: https://api.proofbook.dev/mcp (Bearer pbk_ token).",
        "",
        "Ctrl+C to stop.",
        "",
      ].join("\n"),
    );
  } else {
    process.stderr.write(`proofbook mcp server ready on stdio (${tools.length} tools)\n`);
  }

  async function handleLine(line: string): Promise<void> {
    if (!line.trim()) return;
    let msg: RpcMessage;
    try {
      msg = JSON.parse(line) as RpcMessage;
    } catch {
      return;
    }
    if (msg.method?.startsWith("notifications/")) return;
    if (msg.id === undefined || msg.id === null || !msg.method) return;

    try {
      switch (msg.method) {
        case "initialize":
          write({
            jsonrpc: "2.0",
            id: msg.id,
            result: {
              protocolVersion: (msg.params?.protocolVersion as string) ?? "2025-06-18",
              capabilities: { tools: {} },
              serverInfo: { name: "proofbook", version: "0.1.7" },
              instructions:
                "Read-only evidence tools for this repository's agent telemetry. " +
                "Start with get_coverage_gaps; each gap includes the instrumentation that closes it.",
            },
          });
          break;
        case "ping":
          write({ jsonrpc: "2.0", id: msg.id, result: {} });
          break;
        case "tools/list":
          write({
            jsonrpc: "2.0",
            id: msg.id,
            result: {
              tools: tools.map(({ name, description, inputSchema }) => ({
                name,
                description,
                inputSchema,
              })),
            },
          });
          break;
        case "tools/call": {
          const name = msg.params?.name as string;
          const tool = tools.find((t) => t.name === name);
          if (!tool) {
            write({
              jsonrpc: "2.0",
              id: msg.id,
              error: { code: -32602, message: `unknown tool ${name}` },
            });
            break;
          }
          const args = (msg.params?.arguments as Record<string, unknown>) ?? {};
          const result = await tool.handler(args);
          write({
            jsonrpc: "2.0",
            id: msg.id,
            result: {
              content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
              isError: typeof result === "object" && result !== null && "error" in result,
            },
          });
          break;
        }
        default:
          write({
            jsonrpc: "2.0",
            id: msg.id,
            error: { code: -32601, message: `method not found: ${msg.method}` },
          });
      }
    } catch (err) {
      write({
        jsonrpc: "2.0",
        id: msg.id,
        error: { code: -32603, message: (err as Error).message },
      });
    }
  }

  // Event listeners rather than for-await: the readline async iterator
  // does not reliably settle on stdin EOF, which leaves the process
  // exiting through an unresolved top-level await. Messages are chained
  // so responses keep request order even when handlers do real work.
  const rl = createInterface({ input: process.stdin, terminal: false });
  let queue: Promise<void> = Promise.resolve();
  await new Promise<void>((resolve) => {
    rl.on("line", (line) => {
      queue = queue.then(() => handleLine(line));
    });
    rl.on("close", resolve);
  });
  await queue;
  return 0;
}
