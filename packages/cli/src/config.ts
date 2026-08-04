import { readFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * Project defaults: .proofbook/config.json. Flags always win; the
 * config only fills what the invocation left unsaid, so CI overrides
 * and local runs agree by default.
 *
 *   { "subject": "acme-claims", "frameworks": ["eu-ai-act", "iso-42001"] }
 *
 * Omitted frameworks means all bundled crosswalks, which is the
 * default posture: evaluate everything, share selectively.
 */

export interface ProjectConfig {
  subject?: string;
  frameworks?: string[];
  /** Report language (en, de, fr, es, it, nl). Presentation only. */
  lang?: string;
}

export async function loadConfig(cwd: string): Promise<ProjectConfig> {
  try {
    const raw = JSON.parse(await readFile(join(cwd, ".proofbook", "config.json"), "utf8")) as ProjectConfig;
    return {
      ...(typeof raw.subject === "string" ? { subject: raw.subject } : {}),
      ...(Array.isArray(raw.frameworks) ? { frameworks: raw.frameworks.map(String) } : {}),
      ...(typeof raw.lang === "string" ? { lang: raw.lang } : {}),
    };
  } catch {
    return {};
  }
}
