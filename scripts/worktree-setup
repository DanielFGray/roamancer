#!/usr/bin/env bash
# Idempotent setup Foreman runs before every dispatch in this worktree.
set -euo pipefail
cd "$(dirname "$0")/.."
(cd tools/alchemy && bun install --frozen-lockfile)
