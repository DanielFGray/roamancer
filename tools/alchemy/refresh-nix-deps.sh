#!/usr/bin/env bash
set -euo pipefail

temporary_directory="$(mktemp -d)"
trap 'rm -rf -- "$temporary_directory"' EXIT

jq 'del(.devDependencies)' package.json > "$temporary_directory/package.json"
cp -- bun-production.lock "$temporary_directory/bun.lock"
(
  cd -- "$temporary_directory"
  bun install --lockfile-only --ignore-scripts
)
bunx --no-install bun2nix \
  --lock-file "$temporary_directory/bun.lock" \
  --output-file "$temporary_directory/bun.nix"
mv -f -- "$temporary_directory/bun.lock" bun-production.lock
mv -f -- "$temporary_directory/bun.nix" bun.nix
