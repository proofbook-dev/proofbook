import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { gateCommand } from "../src/commands/gate.js";

const CLAIMS = `span.setAttribute("proofbook.human_checkpoint.type", "approval");\n`;
const MODEL = `span.setAttribute("gen_ai.system", "anthropic");\n`;

async function tree(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "proofbook-gate-cli-"));
  for (const [file, text] of Object.entries(files)) {
    await mkdir(join(dir, file, ".."), { recursive: true });
    await writeFile(join(dir, file), text, "utf8");
  }
  return dir;
}

function collector(): { log: (m: string) => void; lines: string[] } {
  const lines: string[] = [];
  return { log: (m) => lines.push(m), lines };
}

describe("proof gate", () => {
  it("passes with guidance when no lock exists", async () => {
    const cwd = await tree({ "src/llm.ts": MODEL });
    try {
      const { log, lines } = collector();
      expect(await gateCommand({ cwd, log })).toBe(0);
      expect(lines.join("\n")).toMatch(/nothing to enforce/i);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("write then check round-trips clean, and regression exits 2 with names", async () => {
    const cwd = await tree({ "src/claims.ts": CLAIMS, "src/llm.ts": MODEL });
    try {
      expect(await gateCommand({ cwd, write: true, log: () => {} })).toBe(0);
      expect(await gateCommand({ cwd, log: () => {} })).toBe(0);

      await rm(join(cwd, "src/claims.ts"));
      const { log, lines } = collector();
      expect(await gateCommand({ cwd, log })).toBe(2); // regression, not tool error
      const out = lines.join("\n");
      expect(out).toContain("eu-ai-act-a14-checkpoints");
      expect(out).toContain("src/claims.ts:1");
      expect(out).toContain("HumanCheckpoint");
      // The model-call controls are intact and must not be named.
      expect(out).not.toContain("eu-ai-act-a12-record");
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});
