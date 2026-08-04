import en from "./en.js";
import de from "./de.js";
import fr from "./fr.js";
import es from "./es.js";
import it from "./it.js";
import nl from "./nl.js";

/**
 * Report languages. Presentation only, by design: the sealed bundle is
 * canonical and language-free, so re-rendering the same bundle in
 * another language changes nothing an auditor verifies. Catalogs are
 * reviewed translations shipped with the package; nothing is machine
 * translated at render time.
 */

export type Catalog = typeof en;
export type Lang = "en" | "de" | "fr" | "es" | "it" | "nl";

export const LANGS: Record<Lang, { name: string; catalog: Catalog }> = {
  en: { name: "English", catalog: en },
  de: { name: "Deutsch", catalog: de },
  fr: { name: "Français", catalog: fr },
  es: { name: "Español", catalog: es },
  it: { name: "Italiano", catalog: it },
  nl: { name: "Nederlands", catalog: nl },
};

export function isLang(value: string | undefined): value is Lang {
  return value !== undefined && value in LANGS;
}

/** {name} substitution; missing params are left visible, never eaten. */
export function t(catalog: Catalog, key: keyof Catalog, params?: Record<string, string | number>): string {
  let text = catalog[key] as string;
  if (params) {
    for (const [name, value] of Object.entries(params)) {
      text = text.replaceAll(`{${name}}`, String(value));
    }
  }
  return text;
}

/** Per-control translated title and requirement summary. */
export type ControlTranslations = Record<string, { title?: string; requirement_summary?: string }>;
