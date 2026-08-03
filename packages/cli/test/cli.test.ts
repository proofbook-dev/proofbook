import { describe, expect, it } from "vitest";
import { cp, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { discoverTraces } from "../src/discover.js";
import { reportCommand } from "../src/commands/report.js";
import { sealCommand } from "../src/commands/seal.js";
import { verifyCommand } from "../src/commands/verify.js";
import { initCommand } from "../src/commands/init.js";
import { answerCommand, crosswalkCommand, startWatch } from "../src/commands/misc.js";

const fixtures = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "fixtures", "traces");
const basic = join(fixtures, "otel-genai-basic.json");

function collector() {
  const lines: string[] = [];
  return { log: (l: string) => lines.push(l), text: () => lines.join("\n") };
}

async function tmpProject(): Promise<string> {
  return mkdtemp(join(tmpdir(), "proofbook-cli-"));
}

describe("discovery", () => {
  it("finds OTLP files in conventional places and ignores decoys", async () => {
    const cwd = await tmpProject();
    await mkdir(join(cwd, "traces"), { recursive: true });
    await cp(basic, join(cwd, "traces", "prod.json"));
    await writeFile(join(cwd, "package.json"), '{"name":"decoy"}');
    await writeFile(join(cwd, "traces", "notes.json"), '{"hello":"world"}');

    const found = await discoverTraces(cwd);
    expect(found).toHaveLength(1);
    expect(found[0]).toContain("prod.json");
  });
});

describe("proof report", () => {
  it("zero-config: discovers traces, writes HTML and JSON, prints the summary", async () => {
    const cwd = await tmpProject();
    await mkdir(join(cwd, "traces"), { recursive: true });
    await cp(basic, join(cwd, "traces", "prod.json"));

    const out = collector();
    const code = await reportCommand({ cwd, paths: [], log: out.log });
    expect(code).toBe(0);
    expect(out.text()).toContain("Found 1 trace file(s)");
    expect(out.text()).toContain("eu-ai-act: 7 evidenced");

    const html = await readFile(join(cwd, "proofbook-report.html"), "utf8");
    expect(html).toContain("AGENT TRUST REPORT");
    const json = JSON.parse(await readFile(join(cwd, "proofbook-report.json"), "utf8"));
    expect(json.evaluations[0].summary.evidenced).toBe(7);
  });

  it("explains itself when there is nothing to report on", async () => {
    const cwd = await tmpProject();
    const out = collector();
    const code = await reportCommand({ cwd, paths: [], log: out.log });
    expect(code).toBe(3); // insufficient data, not a tool error
    expect(out.text()).toContain("No trace files found");
    expect(out.text()).toContain("proof report path/to/traces.jsonl");
  });
});

describe("proof seal → verify", () => {
  it("seals a chained bundle that verifies, and grows the chain", async () => {
    const cwd = await tmpProject();
    const out = collector();

    const code = await sealCommand({ cwd, paths: [basic], log: out.log });
    expect(code).toBe(0);
    expect(out.text()).toContain("first link");

    const chain = JSON.parse(await readFile(join(cwd, ".proofbook", "chain.json"), "utf8"));
    expect(chain).toHaveLength(1);

    const verifyOut = collector();
    const verifyCode = await verifyCommand({ cwd, dir: chain[0].dir, log: verifyOut.log });
    expect(verifyCode).toBe(0);
    expect(verifyOut.text()).toContain("VALID");

    // Second seal links to the first root.
    const out2 = collector();
    await sealCommand({ cwd, paths: [basic], out: join(cwd, "bundle-2"), log: out2.log });
    expect(out2.text()).toContain(`previous: ${chain[0].root}`);
  });

  it("fails verification loudly after tampering", async () => {
    const cwd = await tmpProject();
    await sealCommand({ cwd, paths: [basic], out: join(cwd, "bundle"), log: () => {} });

    const path = join(cwd, "bundle", "coverage.json");
    await writeFile(path, (await readFile(path, "utf8")).replace('"spans_seen":6', '"spans_seen":9'));

    const out = collector();
    const code = await verifyCommand({ cwd, dir: join(cwd, "bundle"), log: out.log });
    expect(code).toBe(2) /* bundle invalid */;
    expect(out.text()).toContain("INVALID");
    expect(out.text()).toContain("coverage.json");
  });
});

describe("proof init", () => {
  it("detects the stack, writes config, and says the retention truth", async () => {
    const cwd = await tmpProject();
    await writeFile(
      join(cwd, "package.json"),
      JSON.stringify({ name: "acme", dependencies: { ai: "^4.0.0", openai: "^4.0.0" } }),
    );

    const out = collector();
    const code = await initCommand({ cwd, log: out.log });
    expect(code).toBe(0);
    expect(out.text()).toContain("Vercel AI SDK");
    expect(out.text()).toContain("backfill is impossible");

    const config = await readFile(join(cwd, "proofbook.yml"), "utf8");
    expect(config).toContain("eu-ai-act");
  });
});

describe("proof crosswalk / answer / watch", () => {
  it("lists and shows controls", async () => {
    const list = collector();
    expect(await crosswalkCommand({ sub: "list", log: list.log })).toBe(0);
    expect(list.text()).toContain("eu-ai-act-a12-record");

    const show = collector();
    expect(
      await crosswalkCommand({ sub: "show", id: "eu-ai-act-a12-attribution", log: show.log }),
    ).toBe(0);
    expect(show.text()).toContain("ratio(ModelCall[linked(AgentRun)], ModelCall) >= 0.99");
  });

  it("drafts answers from evidence and refuses to invent the rest", async () => {
    const cwd = await tmpProject();
    await writeFile(
      join(cwd, "questions.csv"),
      [
        "Describe the audit trail maintained for autonomous agent recording of events",
        "What is your office dog policy",
      ].join("\n"),
    );

    const out = collector();
    const code = await answerCommand({
      cwd,
      csvPath: join(cwd, "questions.csv"),
      paths: [basic],
      log: out.log,
    });
    expect(code).toBe(0);

    const csv = await readFile(join(cwd, "proofbook-answers.csv"), "utf8");
    expect(csv).toContain("eu-ai-act-a12-record");
    expect(csv).toContain("needs-review");
    expect(csv).toContain("invention");
  });

  it("receives OTLP JSON over HTTP and appends JSONL", async () => {
    const cwd = await tmpProject();
    const handle = await startWatch({ cwd, port: 0, log: () => {} });
    try {
      const doc = await readFile(basic, "utf8");
      const res = await fetch(`http://localhost:${handle.port}/v1/traces`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: doc,
      });
      expect(res.status).toBe(200);
      const bad = await fetch(`http://localhost:${handle.port}/v1/traces`, {
        method: "POST",
        body: "not json",
      });
      expect(bad.status).toBe(400);
    } finally {
      await handle.close();
    }
    const received = await readFile(join(cwd, "traces", "received.jsonl"), "utf8");
    expect(received.trim().split("\n")).toHaveLength(1);
    const found = await discoverTraces(cwd);
    expect(found[0]).toContain("received.jsonl");
  });
});

describe("proof doctor", () => {
  it("reports generations, mapping and capabilities, exit 0 with traces present", async () => {
    const cwd = await tmpProject();
    await mkdir(join(cwd, "traces"), { recursive: true });
    await cp(basic, join(cwd, "traces", "prod.json"));
    const out = collector();
    const { doctorCommand } = await import("../src/commands/doctor.js");
    expect(await doctorCommand({ cwd, log: out.log })).toBe(0);
    expect(out.text()).toContain("otel-genai");
    expect(out.text()).toMatch(/spans mapped/);
  });

  it("exits 3 (insufficient data) with no traces, and --json is parseable", async () => {
    const cwd = await tmpProject();
    const out = collector();
    const { doctorCommand } = await import("../src/commands/doctor.js");
    expect(await doctorCommand({ cwd, json: true, log: out.log })).toBe(3);
    const parsed = JSON.parse(out.text()) as { schema: string; checks: { id: string; status: string }[] };
    expect(parsed.schema).toBe("proofbook.doctor/1");
    expect(parsed.checks.find((c) => c.id === "traces")?.status).toBe("fail");
  });
});

describe("proof mcp tools", () => {
  it("get_coverage_gaps and get_verdict answer from local traces", async () => {
    const cwd = await tmpProject();
    await mkdir(join(cwd, "traces"), { recursive: true });
    await cp(basic, join(cwd, "traces", "prod.json"));
    const { buildMcpTools } = await import("../src/commands/mcp.js");
    const tools = buildMcpTools(cwd);
    expect(tools.map((t) => t.name)).toEqual([
      "list_controls",
      "get_verdict",
      "explain_derivation",
      "get_coverage_gaps",
    ]);
    const gaps = (await tools[3]!.handler({})) as { gaps: { capability: string; fix?: unknown }[] };
    expect(Array.isArray(gaps.gaps)).toBe(true);
    const verdict = (await tools[1]!.handler({ control_id: "eu-ai-act-a12-record" })) as {
      verdict: string;
    };
    expect(verdict.verdict).toBe("evidenced");
  });
});
