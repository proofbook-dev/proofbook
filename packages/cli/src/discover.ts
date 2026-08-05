import { open, readdir, stat } from "node:fs/promises";
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

/** Immediate subdirectory names of a directory (for traces/<source>/). */
async function subdirsOf(dir: string): Promise<string[]> {
  try {
    return (await readdir(dir, { withFileTypes: true }))
      .filter((e) => e.isDirectory() && !SKIP.has(e.name))
      .map((e) => join(dir, e.name));
  } catch {
    return [];
  }
}

export async function discoverTraces(cwd: string): Promise<string[]> {
  const candidates = [...(await candidatesIn(cwd))];
  for (const sub of SUBDIRS) {
    if (SKIP.has(sub)) continue;
    const dir = join(cwd, sub);
    candidates.push(...(await candidatesIn(dir)));
    // One level deeper: `proof pull` writes to traces/<source>/.
    for (const nested of await subdirsOf(dir)) {
      candidates.push(...(await candidatesIn(nested)));
    }
  }
  const found: string[] = [];
  for (const path of candidates.sort()) {
    if (await probeIsOtlp(path)) found.push(path);
  }
  return found;
}

/**
 * Expand explicit path arguments: a file stays as-is, a directory
 * becomes the trace files inside it (and one level of subdirectories),
 * so `proof report traces/datadog` works instead of failing on EISDIR.
 */
export async function expandTracePaths(paths: string[]): Promise<string[]> {
  const out: string[] = [];
  for (const path of paths) {
    let isDir = false;
    try {
      isDir = (await stat(path)).isDirectory();
    } catch {
      out.push(path);
      continue;
    }
    if (!isDir) {
      out.push(path);
      continue;
    }
    out.push(...(await candidatesIn(path)));
    for (const nested of await subdirsOf(path)) {
      out.push(...(await candidatesIn(nested)));
    }
  }
  return out;
}
