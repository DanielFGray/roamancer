#!/usr/bin/env bash
# Tear the ground down. Overlays are deleted, the base image is kept — a reset
# should cost seconds, not a re-download.
set -euo pipefail
URI="qemu:///system"
CACHE="${XDG_CACHE_HOME:-$HOME/.cache}/dlab-testground"

for name in cynic atheist; do
  virsh -c "$URI" destroy "$name" 2>/dev/null || true
  virsh -c "$URI" undefine "$name" --nvram 2>/dev/null || true
  rm -f "$CACHE/disks/$name.qcow2" "$CACHE/disks/$name-seed.iso" \
        "$CACHE/disks/$name-user-data" "$CACHE/disks/$name-meta-data"
done

if [[ "${1:-}" == "--network" ]]; then
  virsh -c "$URI" net-destroy dlab-tg 2>/dev/null || true
  virsh -c "$URI" net-undefine dlab-tg 2>/dev/null || true
fi
echo "ground down; base image kept in $CACHE"
