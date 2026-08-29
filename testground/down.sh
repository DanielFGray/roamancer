#!/usr/bin/env bash
# Tear the ground down. Overlays are deleted, the base image is kept — a reset
# should cost seconds, not a re-download.
set -euo pipefail
URI="qemu:///system"
CACHE="${XDG_CACHE_HOME:-$HOME/.cache}/dlab-testground"

# name : ssh port -- must match up.sh's NODES array. A fresh install means a
# fresh host key every cycle, and the roles that delegate_to: localhost (the
# infra-agent rsync) deliberately keep strict host-key checking rather than
# read the testground inventory's relaxed settings, since that same code path
# deploys to production. So the stale key has to go here instead.
for entry in "cynic:10.13.38.196:2022" "atheist:10.13.38.83:10022"; do
  IFS=: read -r name ip port <<<"$entry"
  virsh -c "$URI" destroy "$name" 2>/dev/null || true
  virsh -c "$URI" undefine "$name" --nvram 2>/dev/null || true
  rm -f "$CACHE/disks/$name.qcow2" "$CACHE/disks/$name-seed.iso" \
        "$CACHE/disks/$name-user-data" "$CACHE/disks/$name-meta-data" \
        "$CACHE/disks/$name-network-config"
  ssh-keygen -R "[$ip]:$port" &>/dev/null || true
done

if [[ "${1:-}" == "--network" ]]; then
  virsh -c "$URI" net-destroy dlab-tg 2>/dev/null || true
  virsh -c "$URI" net-undefine dlab-tg 2>/dev/null || true
fi
echo "ground down; base image kept in $CACHE"
