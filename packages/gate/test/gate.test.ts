import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadCrosswalkDir } from "../../crosswalk/src/index.js";
import {
  buildLock,
  compareToLock,
  controlRequirements,
  loadSignalTable,
  renderLock,
  scanTree,
  type SignalTable,
} from "../src/index.js";

/**
 * The no-false-positive suite for the gate. The DX rule under test:
 * fail only when a control drops to zero emitting call sites, never on
 * partial reduction. A false positive on a blocking check is a P0.
 */

let table: SignalTable;
let root: string;

const CLAIMS = `export async function decide(span: Span, claim: Claim) {
  const approval = await waitForHuman(claim);
  span.setAttribute("proofbook.human_checkpoint.type", "approval");
  span.setAttribute("proofbook.human_checkpoint.decision", approval.decision);
}
`;

const RUNNER = `export function startRun(tracer: Tracer, agent: string) {
  return tracer.startSpan("invoke_agent " + agent, {
    attributes: { "gen_ai.operation.name": "invoke_agent", "gen_ai.agent.id": agent },
  });
}
`;

const LLM_A = `span.setAttribute("gen_ai.system", "anthropic");
span.setAttribute("gen_ai.request.model", model);
`;

const LLM_B = `span.setAttributes({ "gen_ai.system": provider, "gen_ai.response.model": used });
`;

const TOOLS = `span = tracer.startSpan(\`execute_tool \${name}\`);
span.setAttribute("gen_ai.tool.name", name);
`;

async function writeTree(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "proofbook-gate-"));
  for (const [file, text] of Object.entries(files)) {
    await mkdir(join(dir, file, ".."), { recursive: true });
    await writeFile(join(dir, file), text, "utf8");
  }
  return dir;
}

const FULL_TREE = {
  "src/agents/claims.ts": CLAIMS,
  "src/agents/runner.ts": RUNNER,
  "src/llm/anthropic.ts": LLM_A,
  "src/llm/openai.ts": LLM_B,
  "src/tools.ts": TOOLS,
  // Signals inside test paths must not count as production emission.
  "test/claims.test.ts": CLAIMS,
  "src/agents/claims.spec.ts": CLAIMS,
};

beforeAll(async () => {
  table = await loadSignalTable();
  root = await writeTree(FULL_TREE);
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("signal table", () => {
  it("derives signals from the generation rules", () => {
    expect(table.literals.get("proofbook.human_checkpoint.type")).toContain("HumanCheckpoint");
    expect(table.literals.get("invoke_agent")).toContain("AgentRun");
    expect(table.literals.get("execute_tool")).toContain("ToolCall");
    expect(table.literals.get("gen_ai.system")).toContain("ModelCall");
  });

  it("refuses generic words as signals", () => {
    // "chat" is an attr_in value in the generation rules but far too
    // common in ordinary code to be evidence of instrumentation.
    expect(table.literals.has("chat")).toBe(false);
  });
});

describe("scan", () => {
  it("finds emitting sites with file and line", async () => {
    const { sites } = await scanTree(root, table);
    expect(sites.HumanCheckpoint).toEqual([
      expect.objectContaining({ file: "src/agents/claims.ts", line: 3 }),
      expect.objectContaining({ file: "src/agents/claims.ts", line: 4 }),
    ]);
    expect(sites.AgentRun!.length).toBeGreaterThan(0);
    expect(sites.ModelCall!.map((s) => s.file)).toContain("src/llm/anthropic.ts");
    expect(sites.ModelCall!.map((s) => s.file)).toContain("src/llm/openai.ts");
  });

  it("excludes test files and test directories", async () => {
    const { sites } = await scanTree(root, table);
    const files = Object.values(sites).flat().map((s) => s.file);
    expect(files.some((f) => f.startsWith("test/"))).toBe(false);
    expect(files.some((f) => f.endsWith(".spec.ts"))).toBe(false);
  });
});

describe("control requirements", () => {
  it("maps controls to the event types their observed assertions consume", async () => {
    const frameworks = [...(await loadCrosswalkDir()).values()];
    const reqs = controlRequirements(frameworks);
    const oversight = reqs.find((r) => r.control_id === "eu-ai-act-a14-checkpoints");
    expect(oversight?.event_types).toEqual(["HumanCheckpoint"]);
    // Declared-only controls have no observed event types and are
    // outside the gate's jurisdiction.
    const declaredOnly = reqs.find((r) => r.control_id === "eu-ai-act-a13-instructions");
    if (declaredOnly) expect(declaredOnly.event_types).toEqual([]);
  });

  it("includes linked selector types", async () => {
    const frameworks = [...(await loadCrosswalkDir()).values()];
    const reqs = controlRequirements(frameworks);
    const linked = reqs.find((r) => r.control_id === "eu-ai-act-a12-attribution");
    if (linked) expect(linked.event_types).toEqual(["AgentRun", "ModelCall"]);
  });
});

describe("gate", () => {
  async function lockFor(dir: string) {
    const frameworks = [...(await loadCrosswalkDir()).values()];
    const { sites } = await scanTree(dir, table);
    return buildLock({
      requirements: controlRequirements(frameworks),
      sites,
      crosswalk_version: frameworks[0]!.doc.crosswalk_version,
      frameworks: frameworks.map((f) => f.doc.framework),
      source: "scan",
    });
  }

  it("passes when nothing changed", async () => {
    const lock = await lockFor(root);
    const { sites } = await scanTree(root, table);
    const report = compareToLock(lock, sites);
    expect(report.regressions).toEqual([]);
    expect(report.enforced).toContain("eu-ai-act-a14-checkpoints");
  });

  it("stays quiet on partial reduction", async () => {
    const lock = await lockFor(root);
    const { "src/llm/openai.ts": _dropped, ...rest } = FULL_TREE;
    const reduced = await writeTree(rest);
    try {
      const { sites } = await scanTree(reduced, table);
      const report = compareToLock(lock, sites);
      // One of two ModelCall sites is gone; model calls are still
      // emitted, so nothing may fire.
      expect(report.regressions).toEqual([]);
    } finally {
      await rm(reduced, { recursive: true, force: true });
    }
  });

  it("fails with a named control and the removed site at zero", async () => {
    const lock = await lockFor(root);
    const { "src/agents/claims.ts": _dropped, ...rest } = FULL_TREE;
    const gone = await writeTree(rest);
    try {
      const { sites } = await scanTree(gone, table);
      const report = compareToLock(lock, sites);
      const ids = report.regressions.map((r) => r.control_id);
      expect(ids).toContain("eu-ai-act-a14-checkpoints");
      const regression = report.regressions.find(
        (r) => r.control_id === "eu-ai-act-a14-checkpoints",
      )!;
      expect(regression.event_type).toBe("HumanCheckpoint");
      expect(regression.lost_sites[0]).toMatchObject({
        file: "src/agents/claims.ts",
        line: 3,
      });
      // Only human-oversight controls fire; the others remain enforced.
      expect(report.enforced).toContain("eu-ai-act-a12-record");
    } finally {
      await rm(gone, { recursive: true, force: true });
    }
  });

  it("never enforces controls the last evaluation could not evidence", async () => {
    const frameworks = [...(await loadCrosswalkDir()).values()];
    const { sites } = await scanTree(root, table);
    const evidenced = new Map<string, boolean>([["eu-ai-act-a14-checkpoints", false]]);
    const lock = buildLock({
      requirements: controlRequirements(frameworks),
      sites,
      crosswalk_version: frameworks[0]!.doc.crosswalk_version,
      frameworks: frameworks.map((f) => f.doc.framework),
      source: "seal",
      period: "2026-07",
      evidenced,
    });
    const report = compareToLock(lock, {});
    expect(report.regressions.map((r) => r.control_id)).not.toContain(
      "eu-ai-act-a14-checkpoints",
    );
    expect(
      report.unenforced.find((u) => u.control_id === "eu-ai-act-a14-checkpoints")?.reason,
    ).toMatch(/not evidenced/);
  });

  it("renders the lock deterministically", async () => {
    const a = renderLock(await lockFor(root));
    const b = renderLock(await lockFor(root));
    expect(a).toBe(b);
    expect(a.endsWith("\n")).toBe(true);
  });
});
