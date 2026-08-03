import { writeFile } from "node:fs/promises";
import { readBundleDir } from "@proofbook/seal";
import type { Log } from "../log.js";

/**
 * `proof export`: a sealed bundle's verdicts shaped for a GRC
 * platform's custom-evidence intake. The export carries verdicts,
 * derivational metadata and the bundle root for verification; it never
 * upgrades a verdict, and unevaluable stays unevaluable in whatever
 * vocabulary the platform speaks.
 */

export interface ExportOptions {
  dir?: string | undefined;
  format?: string | undefined;
  out?: string | undefined;
  log: Log;
}

const STATUS: Record<string, { vanta: string; drata: string }> = {
  evidenced: { vanta: "OK", drata: "PASSED" },
  partially_evidenced: { vanta: "NEEDS_ATTENTION", drata: "PASSED_WITH_EXCEPTIONS" },
  not_evidenced: { vanta: "DEFICIENT", drata: "FAILED" },
  contradicted: { vanta: "DEFICIENT", drata: "FAILED" },
  unevaluable: { vanta: "NEEDS_ATTENTION", drata: "NOT_APPLICABLE" },
};

export async function exportCommand(opts: ExportOptions): Promise<number> {
  const { log } = opts;
  const format = opts.format ?? "";
  if (!opts.dir || !["vanta", "drata"].includes(format)) {
    log("Usage: proof export <bundle-dir> --format vanta|drata [--out file.json]");
    return 1;
  }
  let files;
  try {
    files = await readBundleDir(opts.dir);
  } catch {
    log(`Cannot read a bundle at ${opts.dir}.`);
    return 1;
  }
  const manifest = JSON.parse(files.get("manifest.json")!) as {
    subject: string;
    period: { label?: string; from: string; to: string } | null;
  };
  const controls: Record<string, unknown>[] = [];
  const root = files.get("manifest.json");
  for (const [path, content] of files) {
    const m = path.match(/^controls\/([^/]+)\/(.+)\.json$/);
    if (!m) continue;
    const c = JSON.parse(content) as {
      control_id: string; article?: string; title: string;
      requirement_summary: string; verdict: string;
    };
    const status = STATUS[c.verdict]!;
    controls.push(
      format === "vanta"
        ? {
            externalId: c.control_id,
            name: `${c.article ? `${c.article} · ` : ""}${c.title}`,
            description: c.requirement_summary.trim(),
            status: status.vanta,
            evidenceDate: manifest.period?.to ?? null,
            framework: m[1],
            source: "proofbook-sealed-bundle",
          }
        : {
            controlCode: c.control_id,
            name: c.title,
            description: c.requirement_summary.trim(),
            result: status.drata,
            collectedAt: manifest.period?.to ?? null,
            framework: m[1],
            evidenceType: "proofbook-sealed-bundle",
          },
    );
  }
  const doc = {
    exported_for: format,
    subject: manifest.subject,
    period: manifest.period,
    note:
      "Statuses are mapped from sealed Proofbook verdicts and never upgraded. " +
      "Attach the sealed bundle itself as the evidence artifact; any reviewer can " +
      "verify it offline with `npx proofbook verify`.",
    controls,
  };
  const out = opts.out ?? `proofbook-${format}-${manifest.period?.label ?? "export"}.json`;
  await writeFile(out, `${JSON.stringify(doc, null, 2)}\n`, "utf8");
  log(`${controls.length} controls exported for ${format}: ${out}`);
  log("Upload via the platform's custom-evidence intake; attach the bundle as the artifact.");
  return 0;
}
