#!/usr/bin/env bash
set -euo pipefail

# Erases a host's disk and installs its NixOS configuration with nixos-anywhere.
# The workstation has no Nix, so the build runs in the nixos/nix container. Its store lives
# in a named volume bound to ~/.cache, not Docker's data root, because a system closure
# fills a small root disk. Docker seeds the empty volume from the image on first use.
#
# Usage: OPS_SITE=<site folder> nixos/install-host.sh <flake host> <ssh target> [extra nixos-anywhere args...]
# The build uses a copy of nixos/ whose `site` folder is replaced by OPS_SITE, so the host gets
# your installation's facts, not the placeholder ones.
# Files under ~/.local/state/server-ansible/extra-files/<host> (SSH host keys, Tailscale
# state, and for a cluster node its CA certificates and password hash) are copied onto the
# new root, so the host keeps its identity across the reinstall. The host's config sets the
# owners and modes of the files it reads; this script sets only those of /etc/ssh and Tailscale.
# Folder modes are copied too: sshd reads authorized_keys.d as the user, so etc/ssh must be 0755.

host="${1:?flake host, such as cynic}"
target="${2:?ssh target, such as operator@192.168.50.10}"
shift 2
repo="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
site="$(cd -- "${OPS_SITE:?set OPS_SITE to the folder that holds your site.toml}" && pwd)"
extra="$HOME/.local/state/server-ansible/extra-files/$host"
key="${SSH_KEY:-$HOME/.ssh/id_ed25519}"
anywhere="github:nix-community/nixos-anywhere/1.11.0"

extra_args=()
if [[ -d "$extra" ]]; then
  extra_args=(--extra-files /extra --chown /etc/ssh 0:0 --chown /var/lib/tailscale 0:0)
fi

store="$HOME/.cache/server-ansible-nix"
if ! docker volume inspect server-ansible-nix >/dev/null 2>&1; then
  mkdir -p -- "$store"
  docker volume create --opt type=none --opt o=bind --opt device="$store" server-ansible-nix >/dev/null
fi

exec docker run --rm --network host \
  --volume server-ansible-nix:/nix \
  --mount "type=bind,src=$repo/nixos,dst=/src,readonly" \
  --mount "type=bind,src=$site,dst=/site,readonly" \
  --mount "type=bind,src=$key,dst=/key,readonly" \
  ${extra_args:+--mount "type=bind,src=$extra,dst=/extra,readonly"} \
  --env NIX_CONFIG="experimental-features = nix-command flakes" \
  nixos/nix:latest sh -euc '
    install -d -m700 /root/.ssh && install -m600 /key /root/.ssh/id
    printf "Host *\n  IdentityFile /root/.ssh/id\n  StrictHostKeyChecking accept-new\n" > /root/.ssh/config
    cp -r /src /work && rm -rf /work/site && cp -r /site /work/site && rm -rf /work/site/.git
    exec nix run "$0" -- --flake "path:/work#$1" --target-host "$2" "${@:3}"
  ' "$anywhere" "$host" "$target" "${extra_args[@]}" "$@"
