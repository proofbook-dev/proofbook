import { access } from "node:fs/promises";
import { join, relative } from "node:path";
import { normalizeOtlpFiles, NormalizeError } from "@proofbook/normalize";
import { loadCrosswalkDir } from "@proofbook/crosswalk";
import { RETENTION, SOURCES } from "@proofbook/sources";
import { liveSealed, openStore } from "@proofbook/store";
import { discoverTraces } from "../discover.js";
import { capabilityImpacts } from "../transcript.js";
import { loadConfig } from "../config.js";
import type { Log } from "../log.js";

/**
 * `proof doctor`: the schema-drift and setup diagnostic. Everything the
 * pipeline decided quietly, said out loud: which convention generations
 * the traces carry, which crosswalk versions are pinned, what did not
 * map and why, which vendor credentials are present, and where the
 * chain stands. Read-only; running it changes nothing.
 */

export interface DoctorCheck {
  id: string;
  status: "ok" | "warn" | "fail";
  detail: string;
}

export interface DoctorResult {
  checks: DoctorCheck[];
  /** 0 clean, 3 insufficient data. */
  exitCode: number;
}

const GLYPH = { ok: "✓", warn: "⚠", fail: "✗" } as const;

export async function runDoctor(cwd: string): Promise<DoctorResult> {
  const checks: DoctorCheck[] = [];
  const push = (id: string, status: DoctorCheck["status"], detail: string) =>
    checks.push({ id, status, detail });

  const major = Number(process.versions.node.split(".")[0]);
  push(
    "runtime",
    major >= 20 ? "ok" : "fail",
    `node ${process.versions.node}${major >= 20 ? "" : " (needs 20+)"}`,
  );

  const config = await loadConfig(cwd);
  const hasJson = await access(join(cwd, ".proofbook", "config.json")).then(() => true, () => false);
  const hasYml = await access(join(cwd, "proofbook.yml")).then(() => true, () => false);
  if (hasJson) {
    push(
      "config",
      "ok",
      `.proofbook/config.json (subject: ${config.subject ?? "unset"}, frameworks: ${config.frameworks?.join(", ") ?? "all"})`,
    );
  } else if (hasYml) {
    push("config", "ok", "proofbook.yml");
  } else {
    push("config", "warn", "no config; flags and defaults apply everywhere (proof init writes one)");
  }

  let crosswalks;
  try {
    crosswalks = await loadCrosswalkDir();
    for (const [name, cw] of crosswalks) {
      push(
        `crosswalk:${name}`,
        "ok",
        `v${cw.doc.crosswalk_version} · ${cw.doc.controls.length} controls`,
      );
    }
  } catch (err) {
    push("crosswalk", "fail", `crosswalk data failed to load: ${(err as Error).message}`);
  }

  const paths = await discoverTraces(cwd);
  if (paths.length === 0) {
    push("traces", "fail", "no trace files found (see: proof report for where it looks)");
  } else {
    push(
      "traces",
      "ok",
      `${paths.length} file${paths.length === 1 ? "" : "s"}: ${paths
        .slice(0, 4)
        .map((p) => relative(cwd, p) || p)
        .join(", ")}${paths.length > 4 ? ", …" : ""}`,
    );
    try {
      const batch = await normalizeOtlpFiles(paths);
      const detections = batch.detections.filter((d) => d.confidence >= 0.2);
      push(
        "generations",
        detections.length > 0 ? "ok" : "warn",
        detections.length > 0
          ? detections.map((d) => `${d.generation} (${Math.round(d.confidence * 100)}%)`).join(" · ")
          : "no known GenAI convention generation fingerprinted; spans map by structural rules only",
      );
      const { spans_seen, spans_mapped, spans_unmapped } = batch.counts;
      const mappedPct = spans_seen === 0 ? 100 : Math.round((spans_mapped / spans_seen) * 1000) / 10;
      push(
        "mapping",
        spans_unmapped === 0 ? "ok" : "warn",
        `${spans_mapped}/${spans_seen} spans mapped (${mappedPct}%)` +
          (spans_unmapped > 0 ? `; ${spans_unmapped} unmapped` : ""),
      );
      if (spans_unmapped > 0) {
        const reasons = new Map<string, number>();
        for (const u of batch.unmapped) reasons.set(u.reason, (reasons.get(u.reason) ?? 0) + 1);
        for (const [reason, count] of [...reasons.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3)) {
          push("mapping:reason", "warn", `${count}× ${reason}`);
        }
      }
      if (crosswalks) {
        for (const impact of capabilityImpacts(batch, [...crosswalks.values()])) {
          if (impact.status === "available") continue;
          push(
            `capability:${impact.capability}`,
            impact.status === "missing" ? "fail" : "warn",
            `${impact.reason ?? impact.status}` +
              (impact.affected > 0
                ? ` → ${impact.affected} control${impact.affected === 1 ? "" : "s"} ${
                    impact.status === "missing" ? "unevaluable" : "degraded"
                  }`
                : ""),
          );
        }
      }
    } catch (err) {
      if (err instanceof NormalizeError) push("mapping", "fail", err.message);
      else throw err;
    }
  }

  for (const adapter of Object.values(SOURCES)) {
    const present = adapter.requiredEnv.filter((k) => process.env[k]);
    if (present.length === 0) continue;
    const complete = present.length === adapter.requiredEnv.length;
    const retention = RETENTION[adapter.name];
    push(
      `source:${adapter.name}`,
      complete ? "ok" : "warn",
      complete
        ? `credentials present${retention ? ` · retention ${retention.note}` : ""}`
        : `partial credentials: missing ${adapter.requiredEnv.filter((k) => !process.env[k]).join(", ")}`,
    );
  }

  try {
    const store = await openStore(join(cwd, ".proofbook", "store"));
    if (store.chain.entries.length === 0) {
      push("chain", "warn", "no sealed periods yet; the retention clock is running (proof seal)");
    } else {
      const head = liveSealed(store).at(-1);
      const gaps = store.chain.entries.filter((e) => e.kind === "gap").length;
      push(
        "chain",
        gaps > 0 ? "warn" : "ok",
        `${store.chain.entries.length} period${store.chain.entries.length === 1 ? "" : "s"}` +
          (head ? `, head ${head.label}` : "") +
          (gaps > 0 ? `, ${gaps} permanent gap${gaps === 1 ? "" : "s"}` : ""),
      );
    }
  } catch {
    push("chain", "warn", "local store unreadable");
  }

  const insufficient = checks.some((c) => c.status === "fail");
  return { checks, exitCode: insufficient ? 3 : 0 };
}

export async function doctorCommand(opts: { cwd: string; json?: boolean; log: Log }): Promise<number> {
  const result = await runDoctor(opts.cwd);
  if (opts.json) {
    opts.log(JSON.stringify({ schema: "proofbook.doctor/1", ...result }, null, 2));
    return result.exitCode;
  }
  for (const check of result.checks) {
    opts.log(`${GLYPH[check.status]} ${check.id.padEnd(26)} ${check.detail}`);
  }
  opts.log("");
  opts.log(
    result.exitCode === 0
      ? "No blockers. Verdicts from this machine mean what they say."
      : "Blocking findings above (exit 3: insufficient data). Each names its fix.",
  );
  return result.exitCode;
}
