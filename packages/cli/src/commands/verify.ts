import { readBundleDir, verifyBundleFiles } from "@proofbook/seal";
import { verifyAttestation } from "@proofbook/provenance";
import type { Log } from "../log.js";

export interface VerifyOptions {
  cwd: string;
  dir: string;
  expectKey?: string | undefined;
  expectRepo?: string | undefined;
  log: Log;
}

export async function verifyCommand(opts: VerifyOptions): Promise<number> {
  const { log } = opts;
  let files;
  try {
    files = await readBundleDir(opts.dir);
  } catch {
    log(`Cannot read a bundle at ${opts.dir}. Expected a directory containing manifest.json.`);
    return 1;
  }

  const structural = verifyBundleFiles(files);
  const attestation = verifyAttestation(files, {
    expected_public_key: opts.expectKey,
    expected_repository: opts.expectRepo,
  });

  const checks = [...structural.checks, ...attestation];
  for (const check of checks) {
    log(`${check.ok ? "✓" : "✕"} ${check.id.padEnd(22)} ${check.detail}`);
  }
  log("");
  const ok = structural.ok && attestation.every((c) => c.ok);
  log(
    ok
      ? `VALID · root ${structural.root}`
      : "INVALID · this bundle has been altered since sealing, does not meet the stated expectations, or was never sealed correctly.",
  );
  return ok ? 0 : 1;
}
