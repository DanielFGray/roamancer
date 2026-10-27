#!/usr/bin/env bash
set -euo pipefail

# Builds the staged Alchemy package outside production.
# The container limit covers every Nix subprocess.
#
# Exit codes:
#   0    the build finished and its output path was recorded
#   1    the build failed, or the container could not run
#   3    not enough free disk to start
#   4    the build was stopped to protect free disk
# Any other code comes from the container itself.

readonly MIN_FREE_KIB=$((2 * 1024 * 1024))
readonly STOP_FREE_KIB=$((1024 * 1024))
readonly EXIT_NO_DISK=3
readonly EXIT_LOW_DISK=4
readonly POLL_SECONDS=2

repo="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
builder_dir="${NIX_BUILDER_DIR:-$HOME/.cache/server-ansible-builder}"
image="${NIX_BUILDER_IMAGE:-nixos/nix:latest}"
# A flake reference inside the source snapshot, such as path:/src#testground-vm.
build_target="${NIX_BUILD_TARGET:-path:/src#alchemy-runner}"
# NixOS disk images run a VM while they build, so they need /dev/kvm. Opt in per build.
kvm_args=()
if [[ "${NIX_BUILDER_KVM:-0}" == "1" ]]; then
  kvm_gid="$(getent group kvm | cut -d: -f3)"
  if [[ -z "$kvm_gid" ]]; then
    printf 'NIX_BUILDER_KVM=1 needs a kvm group on this host\n' >&2
    exit 1
  fi
  kvm_args=(
    --device /dev/kvm
    --group-add "$kvm_gid"
    --env "NIX_CONFIG=system-features = benchmark big-parallel nixos-test uid-range kvm"
  )
fi
mkdir -p -- "$builder_dir/nix" "$builder_dir/tmp"
builder_dir="$(cd -- "$builder_dir" && pwd)"

# One builder at a time. The lock is held until the container is gone.
exec 9>"$builder_dir/build.lock"
flock -x 9

free_kib() {
  df -Pk -- "$builder_dir" | awk 'NR == 2 { print $4 }'
}

available_kib="$(free_kib)"
if (( available_kib < MIN_FREE_KIB )); then
  printf 'Builder needs at least 2 GiB of free disk at %s\n' "$builder_dir" >&2
  exit "$EXIT_NO_DISK"
fi

# The container image carries a Nix store. Copy it once, then reuse it.
if [[ ! -f "$builder_dir/nix/var/nix/db/db.sqlite" ]]; then
  printf 'Seeding the builder Nix store from %s\n' "$image" >&2
  docker run --rm --memory=512m --memory-swap=512m --cpus=1 --pids-limit=128 \
    --mount "type=bind,src=$builder_dir/nix,dst=/destination" \
    "$image" sh -c 'cp -a /nix/. /destination/'
  if [[ ! -f "$builder_dir/nix/var/nix/db/db.sqlite" ]]; then
    printf 'Builder Nix store seed left no Nix database under %s\n' "$builder_dir/nix" >&2
    exit 1
  fi
fi

snapshot="$(mktemp -d "${TMPDIR:-/tmp/opencode}/alchemy-nix-source.XXXXXXXX")"
container=""
build_pid=""
guard_pid=""
low_disk_marker="$builder_dir/low-disk-stop"
out_path_file="$builder_dir/tmp/out-path"
rm -f -- "$low_disk_marker" "$out_path_file"

cleanup() {
  local status=$?
  # Only the top-level shell owns the container.
  [[ "$BASHPID" == "$$" ]] || return "$status"
  trap - EXIT INT TERM HUP
  if [[ -n "$guard_pid" ]]; then
    kill "$guard_pid" 2>/dev/null || true
    wait "$guard_pid" 2>/dev/null || true
  fi
  # The container must go before its mounts, so the snapshot outlives it.
  if [[ -n "$container" ]]; then
    docker rm -f "$container" >/dev/null 2>&1 || true
  fi
  rm -rf -- "$snapshot"
  rm -f -- "$low_disk_marker"
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
trap 'exit 129' HUP

# The source snapshot is read-only in the container and holds no credentials.
tar -C "$repo" \
  --exclude=node_modules --exclude=.alchemy \
  --exclude='.env' --exclude='*.env' --exclude='credentials*' --exclude='secrets*' \
  --exclude='*.pem' --exclude='*.key' \
  -cf - flake.nix flake.lock nixos tools/alchemy | tar -xf - -C "$snapshot"

container="$(docker create --memory=2g --memory-swap=2g --cpus=1 --pids-limit=256 \
  --mount "type=bind,src=$builder_dir/nix,dst=/nix" \
  --mount "type=bind,src=$builder_dir/tmp,dst=/build-tmp" \
  --mount "type=bind,src=$snapshot,dst=/src,readonly" \
  --env TMPDIR=/build-tmp \
  --env "NIX_BUILD_TARGET=$build_target" \
  ${kvm_args[@]+"${kvm_args[@]}"} \
  "$image" sh -c 'nix --extra-experimental-features "nix-command flakes" build --max-jobs 1 --cores 1 --option sandbox false --no-link --print-out-paths "$NIX_BUILD_TARGET" > /build-tmp/out-path')"
if [[ -z "$container" ]]; then
  printf 'docker create returned no container id\n' >&2
  exit 1
fi

docker start --attach "$container" &
build_pid=$!

# The disk guard stops the build before the builder filesystem fills up.
(
  while kill -0 "$build_pid" 2>/dev/null; do
    sleep "$POLL_SECONDS"
    kill -0 "$build_pid" 2>/dev/null || break
    available_kib="$(free_kib)"
    if (( available_kib < STOP_FREE_KIB )); then
      printf 'Stopping builder to preserve 1 GiB of free disk at %s\n' "$builder_dir" >&2
      : >"$low_disk_marker"
      # A stop that fails must not leave the build running on a full disk.
      docker stop --time 10 "$container" >/dev/null 2>&1 ||
        docker rm -f "$container" >/dev/null 2>&1 || true
      break
    fi
  done
) &
guard_pid=$!

build_status=0
wait "$build_pid" || build_status=$?
guard_status=0
wait "$guard_pid" || guard_status=$?

if [[ -f "$low_disk_marker" ]]; then
  printf 'Build stopped: free disk fell below 1 GiB at %s\n' "$builder_dir" >&2
  exit "$EXIT_LOW_DISK"
fi
if (( guard_status != 0 )); then
  printf 'The free disk guard failed with status %d\n' "$guard_status" >&2
  exit 1
fi
if (( build_status != 0 )); then
  printf 'Build failed with status %d\n' "$build_status" >&2
  exit "$build_status"
fi
if [[ ! -s "$out_path_file" ]]; then
  printf 'Build reported success but recorded no output path\n' >&2
  exit 1
fi
cat "$out_path_file"
