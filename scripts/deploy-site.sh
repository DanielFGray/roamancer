#!/usr/bin/env bash
set -euo pipefail

SITE="$1"
CONFIG="/opt/nomad/sites.json"

if ! jq -e ".\"$SITE\"" "$CONFIG" > /dev/null 2>&1; then
  echo "Unknown site: $SITE" >&2
  echo "Available: $(jq -r 'keys | join(", ")' "$CONFIG")" >&2
  exit 1
fi

path=$(jq -r ".\"$SITE\".path" "$CONFIG")
git_root=$(jq -r ".\"$SITE\".git_root // .\"$SITE\".path" "$CONFIG")
install=$(jq -r ".\"$SITE\".install // false" "$CONFIG")
build=$(jq -r ".\"$SITE\".build" "$CONFIG")
dist=$(jq -r ".\"$SITE\".dist" "$CONFIG")
webroot=$(jq -r ".\"$SITE\".webroot" "$CONFIG")

echo "=== Deploying $SITE ==="

cd "$git_root"
git pull --ff-only

if [ "$install" = "true" ]; then
  echo "--- Installing dependencies ---"
  bun install --frozen-lockfile
fi

cd "$path"
echo "--- Building ($build) ---"
eval "$build"

echo "--- Publishing to $webroot ---"
rsync -a --delete "${path}/${dist}/" "${webroot}/"

echo "=== Done: $SITE ==="
