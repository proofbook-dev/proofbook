#!/usr/bin/env node
// Published entry point: runs the compiled CLI. In-repo development
// uses `pnpm proofbook ...` (tsx over the TypeScript sources) instead.
import { main } from "../dist/main.js";

process.exitCode = await main(process.argv.slice(2), process.cwd());
