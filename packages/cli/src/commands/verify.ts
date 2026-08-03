import { readFile, stat } from "node:fs/promises";
import { readBundleDir, verifyBundleFiles } from "@proofbook/seal";
import { verifyAttestation } from "@proofbook/provenance";
import type { Log } from "../log.js";

/**
 * A bundle arrives two ways: as the sealed directory, or as the single
 * JSON file ({ root, files }) the portal serves for download. Both
 * carry identical bytes, so both verify identically.
 */
async function readBundleAny(path: string): Promise<Map<string, string>> {
  if ((await stat(path)).isDirectory()) return readBundleDir(path);
  const parsed = JSON.parse(await readFile(path, "utf8")) as {
    files?: Record<string, string>;
  };
  if (!parsed.files || typeof parsed.files !== "object") {
    throw new Error("not a bundle file");
  }
  return new Map(Object.entries(parsed.files));
}

export interface VerifyOptions {
  cwd: string;
  dir: string;
  expectKey?: string | undefined;
  expectRepo?: string | undefined;
  json?: boolean | undefined;
  log: Log;
}

export async function verifyCommand(opts: VerifyOptions): Promise<number> {
  const { log } = opts;
  let files;
  try {
    files = await readBundleAny(opts.dir);
  } catch {
    log(
      opts.json
        ? JSON.stringify({ schema: "proofbook.verify/1", error: `cannot read a bundle at ${opts.dir}` })
        : `Cannot read a bundle at ${opts.dir}. Expected a bundle directory ` +
            `containing manifest.json, or a downloaded bundle .json file.`,
    );
    return 1;
  }

  const structural = verifyBundleFiles(files);
  const attestation = verifyAttestation(files, {
    expected_public_key: opts.expectKey,
    expected_repository: opts.expectRepo,
  });

  const checks = [...structural.checks, ...attestation];
  const structuralOk = structural.ok;
  const attestationOk = attestation.every((c) => c.ok);
  const ok = structuralOk && attestationOk;
  // 2: the bundle itself does not verify. 4: the bytes verify but the
  // provenance expectations (--expect-key / --expect-repo) are unmet.
  const exit = ok ? 0 : structuralOk ? 4 : 2;

  if (opts.json) {
    log(JSON.stringify({ schema: "proofbook.verify/1", valid: ok, root: structural.root, checks, exit }, null, 2));
    return exit;
  }
  for (const check of checks) {
    log(`${check.ok ? "✓" : "✕"} ${check.id.padEnd(22)} ${check.detail}`);
  }
  log("");
  log(
    ok
      ? `VALID · root ${structural.root}`
      : "INVALID · this bundle has been altered since sealing, does not meet the stated expectations, or was never sealed correctly.",
  );
  return exit;
}
