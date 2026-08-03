#!/bin/sh
# Build the publishable npm package into publish/ (bin: proof, proofbook).
set -e
cd "$(dirname "$0")/.."
rm -rf publish && mkdir -p publish/dist
printf 'import { main } from "%s/packages/cli/src/main.ts";\nprocess.exitCode = await main(process.argv.slice(2), process.cwd());\n' "$PWD" > /tmp/pb-entry.ts
node_modules/.bin/esbuild /tmp/pb-entry.ts --bundle --platform=node --format=esm --target=node20 \
  --banner:js='#!/usr/bin/env node
import { createRequire } from "node:module"; const require = createRequire(import.meta.url);' \
  --outfile=publish/dist/cli.mjs
cp -R packages/normalize/generations publish/generations
cp -R packages/crosswalk/data publish/data
cp README.md scripts/publish-package.json publish/ 2>/dev/null || true
mv publish/publish-package.json publish/package.json
chmod +x publish/dist/cli.mjs
echo "publish/ ready: cd publish && npm publish --access public"
