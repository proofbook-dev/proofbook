import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { normalizeOtlpFiles } from "../packages/normalize/src/index.js";
import { loadCrosswalkDir } from "../packages/crosswalk/src/index.js";
import { evaluateFramework } from "../packages/engine/src/index.js";
import { renderReport } from "../packages/report/src/index.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const fixtures = join(root, "fixtures", "traces");

// Usage: pnpm dlx tsx scripts/demo-report.ts [trace files...]
// With no arguments, the golden fixtures are used.
const inputs =
  process.argv.length > 2
    ? process.argv.slice(2)
    : [join(fixtures, "otel-genai-basic.json"), join(fixtures, "otel-genai-partial.json")];

const batch = await normalizeOtlpFiles(inputs);
const frameworks = await loadCrosswalkDir();
const evaluation = evaluateFramework(batch, frameworks.get("eu-ai-act")!);

const html = renderReport({
  batch,
  evaluations: [evaluation],
  meta: {
    subject: "acme-claims/agent-runtime",
    tool_version: "0.1.0",
    generated_at: new Date().toISOString(),
  },
});

await mkdir(join(root, "tmp"), { recursive: true });
const out = join(root, "tmp", "agent-trust-report.html");
await writeFile(out, html);
console.log(`report written: ${out}`);
console.log(`summary:`, JSON.stringify(evaluation.summary));
