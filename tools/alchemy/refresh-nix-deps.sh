#!/usr/bin/env bash
# Regenerates the two Nix inputs from package.json:
# - bun-production.lock: the runner's install, with no devDependencies.
# - bun.nix: the package cache for every Nix build. It is generated from the full bun.lock,
#   because the fleet page builds with devDependencies (Vite and the Solid compiler).
#   The runner installs from bun-production.lock and uses only part of the cache.
set -euo pipefail

temporary_directory="$(mktemp -d)"
trap 'rm -rf -- "$temporary_directory"' EXIT

jq 'del(.devDependencies)' package.json > "$temporary_directory/package.json"
cp -- bun-production.lock "$temporary_directory/bun.lock"
(
  cd -- "$temporary_directory"
  bun install --lockfile-only --ignore-scripts
)
bun install --lockfile-only --ignore-scripts
bunx --no-install bun2nix \
  --lock-file bun.lock \
  --output-file "$temporary_directory/bun.nix"
mv -f -- "$temporary_directory/bun.lock" bun-production.lock
mv -f -- "$temporary_directory/bun.nix" bun.nix
