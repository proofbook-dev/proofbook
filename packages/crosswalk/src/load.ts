import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { parse as parseYaml } from "yaml";
import { Assertion, CrosswalkFile, EquivalenceFile } from "./schema.js";
import { parseExpression, ExpressionError } from "./expression.js";

export class CrosswalkError extends Error {}

export interface LoadedCrosswalk {
  doc: CrosswalkFile;
  /** Content pin: every bundle records this so verdicts trace to exact text. */
  pin: string;
}

function checkAssertion(a: Assertion, controlId: string): void {
  try {
    parseExpression(a.expression);
    if (a.partial_expression !== undefined) parseExpression(a.partial_expression);
  } catch (err) {
    if (err instanceof ExpressionError) {
      throw new CrosswalkError(`${controlId} / ${a.id}: ${err.message}`);
    }
    throw err;
  }
  if (a.source_class === "observed" && a.capability === undefined) {
    throw new CrosswalkError(
      `${controlId} / ${a.id}: observed assertions must name the capability they depend on, ` +
        `so an unevaluable verdict can say exactly what the telemetry could not provide`,
    );
  }
  if (a.partial_expression !== undefined && a.verdict_map.partial === undefined) {
    throw new CrosswalkError(
      `${controlId} / ${a.id}: partial_expression requires verdict_map.partial`,
    );
  }
}

export function loadCrosswalkText(text: string): LoadedCrosswalk {
  const doc = CrosswalkFile.parse(parseYaml(text));

  const controlIds = new Set<string>();
  const assertionIds = new Set<string>();
  for (const control of doc.controls) {
    if (controlIds.has(control.id)) {
      throw new CrosswalkError(`duplicate control id: ${control.id}`);
    }
    controlIds.add(control.id);
    for (const assertion of control.assertions) {
      if (assertionIds.has(assertion.id)) {
        throw new CrosswalkError(`duplicate assertion id: ${assertion.id}`);
      }
      assertionIds.add(assertion.id);
      checkAssertion(assertion, control.id);
    }
  }

  return {
    doc,
    pin: `sha256:${createHash("sha256").update(text, "utf8").digest("hex")}`,
  };
}

/** Default location of the published crosswalk data in this repository. */
export const defaultCrosswalkDir = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "data",
);

export async function loadCrosswalkDir(
  dir = defaultCrosswalkDir,
): Promise<Map<string, LoadedCrosswalk>> {
  const frameworksDir = join(dir, "frameworks");
  const files = (await readdir(frameworksDir)).filter((f) => f.endsWith(".yaml")).sort();
  const out = new Map<string, LoadedCrosswalk>();
  for (const file of files) {
    const loaded = loadCrosswalkText(await readFile(join(frameworksDir, file), "utf8"));
    if (out.has(loaded.doc.framework)) {
      throw new CrosswalkError(`framework "${loaded.doc.framework}" defined twice`);
    }
    out.set(loaded.doc.framework, loaded);
  }
  return out;
}

export async function loadEquivalence(
  frameworks: Map<string, LoadedCrosswalk>,
  dir = defaultCrosswalkDir,
): Promise<EquivalenceFile> {
  const doc = EquivalenceFile.parse(
    parseYaml(await readFile(join(dir, "equivalence.yaml"), "utf8")),
  );

  // Control ids for frameworks that exist here must actually exist.
  // Pending entries name identifiers for frameworks not yet shipped.
  for (const entry of doc.equivalences) {
    for (const [framework, ref] of Object.entries(entry.controls)) {
      if (!Array.isArray(ref)) continue;
      const loaded = frameworks.get(framework);
      if (!loaded) {
        throw new CrosswalkError(
          `equivalence "${entry.evidence}" references framework "${framework}" ` +
            `with concrete ids, but that framework is not in the crosswalk; mark it pending`,
        );
      }
      const known = new Set(loaded.doc.controls.map((c) => c.id));
      for (const controlId of ref) {
        if (!known.has(controlId)) {
          throw new CrosswalkError(
            `equivalence "${entry.evidence}" references unknown control "${controlId}" in ${framework}`,
          );
        }
      }
    }
  }
  return doc;
}

/**
 * Reviewed control-text translations: control_id → { title,
 * requirement_summary }. Presentation only; the sealed bundle keeps the
 * canonical English paraphrases, and a missing translation falls back
 * to them rather than to anything generated.
 */
export async function loadControlTranslations(
  lang: string,
  dir?: string,
): Promise<Record<string, { title?: string; requirement_summary?: string }>> {
  if (lang === "en") return {};
  const base = dir ?? defaultCrosswalkDir;
  try {
    const text = await readFile(join(base, "i18n", `${lang}.yaml`), "utf8");
    const parsed = parseYaml(text) as Record<string, { title?: string; requirement_summary?: string }>;
    return parsed ?? {};
  } catch {
    return {};
  }
}
