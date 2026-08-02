import { open, readdir } from "node:fs/promises";
import { join } from "node:path";

/**
 * Zero-config trace discovery.
 *
 * `proof report` with no arguments must find traces in common
 * locations and produce output; prompting for configuration before
 * showing value is a failure. Discovery is shallow and cheap: the
 * working directory plus a few conventional subdirectories, one level
 * deep, probing the first bytes of each candidate for OTLP shape.
 */

const SUBDIRS = ["traces", "telemetry", "otel", "tmp", "out"];
const SKIP = new Set(["node_modules", ".git", "dist"]);

async function probeIsOtlp(path: string): Promise<boolean> {
  let handle;
  try {
    handle = await open(path, "r");
    const buf = Buffer.alloc(4096);
    const { bytesRead } = await handle.read(buf, 0, 4096, 0);
    const head = buf.subarray(0, bytesRead).toString("utf8");
    return head.includes("resourceSpans") || head.includes("resource_spans");
  } catch {
    return false;
  } finally {
    await handle?.close();
  }
}

async function candidatesIn(dir: string): Promise<string[]> {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    return entries
      .filter((e) => e.isFile() && /\.(json|jsonl)$/.test(e.name))
      .map((e) => join(dir, e.name));
  } catch {
    return [];
  }
}

export async function discoverTraces(cwd: string): Promise<string[]> {
  const candidates = [...(await candidatesIn(cwd))];
  for (const sub of SUBDIRS) {
    if (SKIP.has(sub)) continue;
    candidates.push(...(await candidatesIn(join(cwd, sub))));
  }
  const found: string[] = [];
  for (const path of candidates.sort()) {
    if (await probeIsOtlp(path)) found.push(path);
  }
  return found;
}
