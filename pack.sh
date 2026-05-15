#!/usr/bin/env bash
# pack.sh — convenience wrapper around `npm run pack`.
# Builds dist/ via build.js then zips it via pack.js.
# Output: ~/younote-vX.Y.Z.zip ready for Web Store upload or sideload.
set -euo pipefail

cd "$(dirname "$0")"

if [ ! -d node_modules ]; then
  echo "node_modules/ not found — running npm install (one-time, ~30 MB)…"
  npm install
fi

npm run pack
