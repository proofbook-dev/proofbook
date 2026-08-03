import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { datadog } from "./datadog.js";
import { langfuse } from "./langfuse.js";
import { langsmith } from "./langsmith.js";
import { tempo } from "./tempo.js";
import { s3 } from "./s3.js";
import { SourceError, type SourceAdapter, type Window } from "./types.js";

export * from "./types.js";
export { datadog, langfuse, langsmith, tempo, s3 };

export const SOURCES: Record<string, SourceAdapter> = {
  datadog,
  langfuse,
  langsmith,
  tempo,
  s3,
};

export function getSource(name: string): SourceAdapter {
  const adapter = SOURCES[name];
  if (!adapter) {
    throw new SourceError(
      `Unknown source "${name}". Available: ${Object.keys(SOURCES).join(", ")}, ` +
        `or pass trace files/directories directly.`,
    );
  }
  return adapter;
}

/**
 * Window parsing for pull: month labels (2026-07), last-month,
 * this-month, or a rolling last-Nd window (last-30d).
 */
export function parseWindow(spec: string, now: Date = new Date()): Window {
  const rolling = spec.match(/^last-(\d+)d$/);
  if (rolling) {
    const days = Number(rolling[1]);
    return {
      fromISO: new Date(now.getTime() - days * 86400_000).toISOString(),
      toISO: now.toISOString(),
    };
  }
  const month = (y: number, m: number): Window => ({
    fromISO: new Date(Date.UTC(y, m, 1)).toISOString(),
    toISO: new Date(Date.UTC(y, m + 1, 1)).toISOString(),
  });
  if (spec === "this-month") return month(now.getUTCFullYear(), now.getUTCMonth());
  if (spec === "last-month") return month(now.getUTCFullYear(), now.getUTCMonth() - 1);
  const label = spec.match(/^(\d{4})-(\d{2})$/);
  if (label) return month(Number(label[1]), Number(label[2]) - 1);
  throw new SourceError(
    `Cannot parse period "${spec}". Use last-30d, last-month, this-month or YYYY-MM.`,
  );
}

/** Fetch a source into a directory of OTLP files; returns their paths. */
export async function pullToDir(
  name: string,
  window: Window,
  dir: string,
  opts: { env?: Record<string, string | undefined>; fetchImpl?: typeof fetch; log?: (m: string) => void } = {},
): Promise<string[]> {
  const adapter = getSource(name);
  const files = await adapter.fetch({
    window,
    env: opts.env ?? process.env,
    fetchImpl: opts.fetchImpl ?? fetch,
    log: opts.log ?? (() => {}),
  });
  await mkdir(dir, { recursive: true });
  const paths: string[] = [];
  for (const file of files) {
    const path = join(dir, file.name);
    await writeFile(path, file.content, "utf8");
    paths.push(path);
  }
  return paths;
}
