#!/bin/sh
# Rebuilds hooks/vendor/shiki.js: Shiki with the Vue and Svelte grammars and two themes, one ESM file.
set -e
here=$(cd "$(dirname "$0")" && pwd)
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
cp "$here/entry.ts" "$work/"
cd "$work"
npm init -y >/dev/null
npm install --silent --no-audit --no-fund shiki@3.23.0 esbuild@0.25.10
npx esbuild entry.ts --bundle --format=esm --platform=neutral --minify --legal-comments=none \
  --banner:js="// Shiki $(node -p 'require("shiki/package.json").version') (MIT), its Vue and Svelte grammars and the Monokai and GitHub Light themes. Built by scripts/shiki/build.sh." \
  --outfile="$here/../../hooks/vendor/shiki.js"
