import { readdir, readFile, stat } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import type { SignalTable } from "./signals.js";

/**
 * The scanner: walk a source tree, find lines containing emission
 * signals, record them as call sites per event type.
 *
 * Deliberately its own walker rather than `git ls-files`: the scan must
 * behave identically on a fresh CI checkout, a dirty worktree and a
 * non-repo directory, because the lock it feeds is diffed byte for byte.
 *
 * Test and fixture paths are excluded. A control whose only emitting
 * site lives in a test file is not backed in production, and counting
 * it would let the gate pass while the next sealed period reads
 * unevaluable.
 */

export interface Site {
  /** Path relative to the scan root, forward slashes. */
  file: string;
  line: number;
  signal: string;
}

/** event type → sites, sorted by (file, line, signal). */
export type SiteIndex = Record<string, Site[]>;

export interface ScanResult {
  sites: SiteIndex;
  files_scanned: number;
}

const SOURCE_EXTENSIONS = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs",
  ".py", ".rb", ".go", ".java", ".kt", ".cs", ".php", ".rs", ".scala", ".swift",
]);

const EXCLUDED_DIRS = new Set([
  "node_modules", "dist", "build", "out", "coverage", "vendor", "target",
  "__pycache__", ".git", ".proofbook", ".venv", "venv",
  "test", "tests", "__tests__", "fixtures", "fixture", "examples", "example", "docs",
]);

const TEST_FILE = /\.(test|spec)\.[a-z]+$/;

/** Minified or generated content; a signal in it is not a call site anyone edits. */
const MAX_FILE_BYTES = 1024 * 1024;
const MAX_LINE_CHARS = 500;

function extensionOf(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot === -1 ? "" : name.slice(dot);
}

async function listSourceFiles(root: string): Promise<string[]> {
  const found: string[] = [];
  async function walk(dir: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!EXCLUDED_DIRS.has(entry.name) && !entry.name.startsWith(".")) await walk(path);
      } else if (
        entry.isFile() &&
        SOURCE_EXTENSIONS.has(extensionOf(entry.name)) &&
        !TEST_FILE.test(entry.name)
      ) {
        found.push(path);
      }
    }
  }
  await walk(root);
  return found.sort();
}

function boundaryRegex(literal: string): RegExp {
  const escaped = literal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^A-Za-z0-9_.$@/-])${escaped}($|[^A-Za-z0-9_.$@/-])`);
}

export async function scanTree(root: string, table: SignalTable): Promise<ScanResult> {
  const matchers = [...table.literals.entries()].map(([literal, types]) => ({
    literal,
    types,
    regex: boundaryRegex(literal),
  }));

  const sites: SiteIndex = {};
  const files = await listSourceFiles(root);
  let scanned = 0;

  for (const path of files) {
    try {
      if ((await stat(path)).size > MAX_FILE_BYTES) continue;
    } catch {
      continue;
    }
    let text;
    try {
      text = await readFile(path, "utf8");
    } catch {
      continue;
    }
    scanned += 1;
    const file = relative(root, path).split(sep).join("/");
    const lines = text.split("\n");
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i]!;
      if (line.length > MAX_LINE_CHARS) continue;
      for (const { literal, types, regex } of matchers) {
        if (!line.includes(literal) || !regex.test(line)) continue;
        for (const type of types) {
          (sites[type] ??= []).push({ file, line: i + 1, signal: literal });
        }
      }
    }
  }

  for (const type of Object.keys(sites)) {
    const seen = new Set<string>();
    sites[type] = sites[type]!
      .filter((s) => {
        const key = `${s.file}:${s.line}:${s.signal}`;
        return seen.has(key) ? false : (seen.add(key), true);
      })
      .sort((a, b) =>
        a.file !== b.file ? (a.file < b.file ? -1 : 1)
        : a.line !== b.line ? a.line - b.line
        : a.signal < b.signal ? -1 : a.signal > b.signal ? 1 : 0,
      );
  }

  return { sites, files_scanned: scanned };
}
