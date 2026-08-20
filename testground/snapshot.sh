#!/usr/bin/env bash
# Snapshot or roll back both nodes. A playbook run is destructive and the
# interesting failures are the ones on a clean base, so rolling back is the
# operation that gets used most.
#   snapshot.sh save base
#   snapshot.sh restore base
set -euo pipefail
URI="qemu:///system"
action="${1:?save|restore|list}"
tag="${2:-base}"

for name in cynic atheist; do
  case "$action" in
    save)    virsh -c "$URI" snapshot-create-as "$name" "$tag" --atomic ;;
    restore) virsh -c "$URI" snapshot-revert "$name" "$tag" --running ;;
    list)    echo "== $name"; virsh -c "$URI" snapshot-list "$name" ;;
    *) echo "usage: snapshot.sh save|restore|list [tag]" >&2; exit 1 ;;
  esac
done
