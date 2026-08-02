import { describe, expect, it } from "vitest";
import { createServer } from "node:http";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { sealCommand } from "../../cli/src/commands/seal.js";
import { chainCommand } from "../../cli/src/commands/chain.js";
import { pushCommand } from "../../cli/src/commands/push.js";
import {
  monthPeriod,
  monthsBetween,
  openStore,
  resolvePeriod,
  verifyChain,
} from "../src/index.js";

const fixtures = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "fixtures", "traces");
const basic = join(fixtures, "otel-genai-basic.json"); // events on 2026-07-10

function collector() {
  const lines: string[] = [];
  return { log: (l: string) => lines.push(l), text: () => lines.join("\n") };
}

/** The basic fixture shifted back by whole months, for multi-period chains. */
async function fixtureForMonth(dir: string, monthsBack: number): Promise<string> {
  const doc = await readFile(basic, "utf8");
  const shifted = doc.replace(/"(\d{19})"/g, (_, nanos: string) => {
    const shiftedNanos = BigInt(nanos) - BigInt(monthsBack) * 30n * 86_400_000_000_000n;
    return `"${shiftedNanos}"`;
  });
  const path = join(dir, `traces-m${monthsBack}.json`);
  await writeFile(path, shifted);
  return path;
}

describe("period semantics", () => {
  it("computes half-open UTC month windows", () => {
    const p = monthPeriod("2026-07");
    expect(p.from).toBe("2026-07-01T00:00:00.000Z");
    expect(p.to).toBe("2026-08-01T00:00:00.000Z");
    expect(() => monthPeriod("2026-13")).toThrow();
    expect(() => monthPeriod("july")).toThrow();
  });

  it("resolves relative periods against an injected clock", () => {
    const now = new Date("2026-08-02T22:00:00Z");
    expect(resolvePeriod("last-month", now).label).toBe("2026-07");
    expect(resolvePeriod("this-month", now).label).toBe("2026-08");
    // Year boundary.
    expect(resolvePeriod("last-month", new Date("2026-01-15T00:00:00Z")).label).toBe("2025-12");
  });

  it("enumerates the months a gap spans", () => {
    expect(monthsBetween("2026-04", "2026-07")).toEqual(["2026-05", "2026-06"]);
    expect(monthsBetween("2026-06", "2026-07")).toEqual([]);
    expect(monthsBetween("2025-11", "2026-02")).toEqual(["2025-12", "2026-01"]);
  });
});

describe("sealing periods: continuity, idempotency, gaps", () => {
  it("seals a period, then the next, linking the chain", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pb-store-"));
    const june = await fixtureForMonth(cwd, 1); // 2026-06-10

    const out1 = collector();
    expect(await sealCommand({ cwd, paths: [june], period: "2026-06", log: out1.log })).toBe(0);
    expect(out1.text()).toContain("period:   2026-06");
    expect(out1.text()).toContain("none (first link)");

    const out2 = collector();
    expect(await sealCommand({ cwd, paths: [basic], period: "2026-07", log: out2.log })).toBe(0);
    expect(out2.text()).not.toContain("GAP");

    const store = await openStore(join(cwd, ".proofbook", "store"));
    const report = await verifyChain(store);
    expect(report.ok).toBe(true);
    expect(report.sealed).toBe(2);
    expect(report.gaps).toHaveLength(0);
  });

  it("filters spans to the declared window and refuses an empty period", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pb-store-"));
    const out = collector();
    // basic has July events only; sealing May finds nothing.
    const code = await sealCommand({ cwd, paths: [basic], period: "2026-05", log: out.log });
    expect(code).toBe(1);
    expect(out.text()).toContain("No spans fall inside 2026-05");
  });

  it("is idempotent: identical re-seal is a no-op, divergent is refused, supersede records", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pb-store-"));
    const out1 = collector();
    expect(await sealCommand({ cwd, paths: [basic], period: "2026-07", log: out1.log })).toBe(0);

    // Identical content: no-op.
    const out2 = collector();
    expect(await sealCommand({ cwd, paths: [basic], period: "2026-07", log: out2.log })).toBe(0);
    expect(out2.text()).toContain("already sealed with identical content");

    // Divergent content (different subject changes the manifest): refused.
    const out3 = collector();
    expect(
      await sealCommand({ cwd, paths: [basic], period: "2026-07", subject: "other", log: out3.log }),
    ).toBe(1);
    expect(out3.text()).toContain("DIFFERENT content");
    expect(out3.text()).toContain("--supersede");

    // Supersede: recorded, both entries in the ledger, chain still verifies.
    const out4 = collector();
    expect(
      await sealCommand({
        cwd, paths: [basic], period: "2026-07", subject: "other", supersede: true, log: out4.log,
      }),
    ).toBe(0);
    const store = await openStore(join(cwd, ".proofbook", "store"));
    expect(store.chain.entries.filter((e) => e.label === "2026-07")).toHaveLength(2);
    expect(store.chain.entries[0]!.superseded_by).toBeDefined();
    expect((await verifyChain(store)).ok).toBe(true);
  });

  it("records skipped months as explicit gaps, loudly", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pb-store-"));
    const april = await fixtureForMonth(cwd, 3); // 2026-04-11
    await sealCommand({ cwd, paths: [april], period: "2026-04", log: () => {} });

    const out = collector();
    expect(await sealCommand({ cwd, paths: [basic], period: "2026-07", log: out.log })).toBe(0);
    expect(out.text()).toContain("GAP: 2026-05, 2026-06 were never sealed");

    const store = await openStore(join(cwd, ".proofbook", "store"));
    const gaps = store.chain.entries.filter((e) => e.kind === "gap").map((e) => e.label);
    expect(gaps).toEqual(["2026-05", "2026-06"]);

    // The chain command reports them and still verifies.
    const chainOut = collector();
    expect(await chainCommand({ cwd, log: chainOut.log })).toBe(0);
    expect(chainOut.text()).toContain("2026-05  GAP");
    expect(chainOut.text()).toContain("2 explicit gap(s)");
  });

  it("detects a broken chain link and a tampered stored bundle", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pb-store-"));
    const june = await fixtureForMonth(cwd, 1);
    await sealCommand({ cwd, paths: [june], period: "2026-06", log: () => {} });
    await sealCommand({ cwd, paths: [basic], period: "2026-07", log: () => {} });

    const store = await openStore(join(cwd, ".proofbook", "store"));
    const julyDir = store.chain.entries.find((e) => e.label === "2026-07")!.dir!;
    const coverage = join(julyDir, "coverage.json");
    await writeFile(coverage, (await readFile(coverage, "utf8")).replace('"spans_seen":6', '"spans_seen":66'));

    const out = collector();
    expect(await chainCommand({ cwd, log: out.log })).toBe(1);
    expect(out.text()).toContain("Chain INVALID");
    expect(out.text()).toContain("2026-07");
  });

  it("emits a markdown summary for CI", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pb-store-"));
    await sealCommand({ cwd, paths: [basic], period: "2026-07", log: () => {} });
    const out = collector();
    expect(await chainCommand({ cwd, markdown: true, log: out.log })).toBe(0);
    expect(out.text()).toContain("| Period | Status | Root |");
    expect(out.text()).toContain("✅ Chain verifies");
  });
});

describe("proof push", () => {
  it("pushes only the bundle, with auth, and surfaces rejections honestly", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pb-store-"));
    await sealCommand({ cwd, paths: [basic], period: "2026-07", log: () => {} });

    const received: Array<{ auth: string | undefined; body: string }> = [];
    const server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        received.push({ auth: req.headers.authorization, body: Buffer.concat(chunks).toString() });
        res.writeHead(received.length > 1 ? 500 : 200, { "content-type": "application/json" });
        res.end('{"id":"b_123"}');
      });
    });
    await new Promise<void>((r) => server.listen(0, r));
    const port = (server.address() as { port: number }).port;

    try {
      const out = collector();
      expect(
        await pushCommand({
          cwd, url: `http://localhost:${port}`, token: "tok_test", log: out.log,
        }),
      ).toBe(0);
      expect(out.text()).toContain("pushed 2026-07");
      expect(received[0]!.auth).toBe("Bearer tok_test");

      const body = JSON.parse(received[0]!.body) as { root: string; files: Record<string, string> };
      expect(Object.keys(body.files)).toContain("manifest.json");
      expect(body.body ?? "").not.toContain("Triage this claim");
      expect(JSON.stringify(body)).not.toContain("Triage this claim");

      // Server error: honest message, bundle stays safe.
      const out2 = collector();
      expect(
        await pushCommand({ cwd, url: `http://localhost:${port}`, token: "tok_test", log: out2.log }),
      ).toBe(1);
      expect(out2.text()).toContain("sealed and safe locally");
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  it("explains itself without a token", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pb-store-"));
    await sealCommand({ cwd, paths: [basic], period: "2026-07", log: () => {} });
    const out = collector();
    const prev = process.env.PROOFBOOK_TOKEN;
    delete process.env.PROOFBOOK_TOKEN;
    try {
      expect(await pushCommand({ cwd, log: out.log })).toBe(1);
      expect(out.text()).toContain("PROOFBOOK_TOKEN");
      expect(out.text()).toContain("free tier");
    } finally {
      if (prev !== undefined) process.env.PROOFBOOK_TOKEN = prev;
    }
  });
});

describe("the evidence Action", () => {
  it("is a composite wrapper over the CLI with zero required inputs", async () => {
    const { parse } = await import("yaml");
    const text = await readFile(
      join(dirname(fileURLToPath(import.meta.url)), "..", "..", "action", "action.yml"),
      "utf8",
    );
    const doc = parse(text) as {
      inputs: Record<string, { required?: boolean; default?: string }>;
      runs: { using: string; steps: Array<{ run?: string; uses?: string }> };
    };

    const required = Object.entries(doc.inputs).filter(([, v]) => v.required).map(([k]) => k);
    expect(required).toEqual([]);
    expect(doc.inputs.period!.default).toBe("last-month");
    expect(doc.runs.using).toBe("composite");

    // Thin wrapper: every run step goes through the CLI, no duplicated logic.
    const runSteps = doc.runs.steps.filter((s) => s.run);
    expect(runSteps.length).toBeGreaterThanOrEqual(3);
    for (const step of runSteps) expect(step.run).toContain("npx proofbook");
    expect(text).toContain("GITHUB_STEP_SUMMARY");
    expect(doc.runs.steps.some((s) => s.uses?.startsWith("actions/upload-artifact"))).toBe(true);
  });
});
