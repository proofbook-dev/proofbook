import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { z } from "zod";
import type { ControlRequirement } from "./map.js";
import type { Site, SiteIndex } from "./scan.js";

/**
 * The instrumentation lock: a checked-in snapshot of which code sites
 * emitted the events backing each control, taken at a known-good
 * moment, ideally by `proof seal` right after evidence actually
 * evaluated. The gate diffs the present against this file.
 *
 * No timestamps and fully sorted keys: the same tree must produce the
 * same bytes, so the lock diffs cleanly in review and never churns.
 */

export const LOCK_VERSION = 1;

const LockSite = z.object({
  file: z.string(),
  line: z.number().int().positive(),
  signal: z.string(),
});

const LockControl = z.object({
  framework: z.string(),
  title: z.string(),
  event_types: z.array(z.string()),
  /**
   * Written by seal: did this control actually reach evidenced or
   * partially_evidenced in the last evaluation? A control that never
   * produced evidence is not enforced; the gate protects what exists,
   * it does not demand what never did.
   */
  evidenced: z.boolean().optional(),
});

export const LockFile = z.object({
  version: z.literal(LOCK_VERSION),
  crosswalk_version: z.string(),
  frameworks: z.array(z.string()),
  /** What produced this lock: an evidence run (seal) or a bare scan. */
  source: z.enum(["seal", "scan"]),
  /** Sealed period label, when source is seal. */
  period: z.string().optional(),
  sites: z.record(z.array(LockSite)),
  controls: z.record(LockControl),
});
export type LockFile = z.infer<typeof LockFile>;

export function lockPath(cwd: string): string {
  return join(cwd, ".proofbook", "instrumentation.lock");
}

export interface BuildLockOptions {
  requirements: ControlRequirement[];
  sites: SiteIndex;
  crosswalk_version: string;
  frameworks: string[];
  source: "seal" | "scan";
  period?: string | undefined;
  /** control_id → reached evidenced/partially_evidenced in the last evaluation. */
  evidenced?: Map<string, boolean> | undefined;
}

export function buildLock(opts: BuildLockOptions): LockFile {
  const sites: Record<string, Site[]> = {};
  for (const type of Object.keys(opts.sites).sort()) {
    if (opts.sites[type]!.length > 0) sites[type] = opts.sites[type]!;
  }

  const controls: LockFile["controls"] = {};
  for (const req of opts.requirements) {
    controls[req.control_id] = {
      framework: req.framework,
      title: req.title,
      event_types: req.event_types,
      ...(opts.evidenced?.has(req.control_id)
        ? { evidenced: opts.evidenced.get(req.control_id)! }
        : {}),
    };
  }

  return LockFile.parse({
    version: LOCK_VERSION,
    crosswalk_version: opts.crosswalk_version,
    frameworks: [...opts.frameworks].sort(),
    source: opts.source,
    ...(opts.period !== undefined ? { period: opts.period } : {}),
    sites,
    controls,
  });
}

export function renderLock(lock: LockFile): string {
  return `${JSON.stringify(lock, null, 2)}\n`;
}

export function parseLock(text: string): LockFile {
  return LockFile.parse(JSON.parse(text));
}

export async function readLock(path: string): Promise<LockFile | null> {
  try {
    return parseLock(await readFile(path, "utf8"));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

export async function writeLock(path: string, lock: LockFile): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, renderLock(lock), "utf8");
}
