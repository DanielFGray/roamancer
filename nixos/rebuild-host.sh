#!/usr/bin/env bash
set -euo pipefail

# Switches a running host to this checkout's NixOS configuration.
# Copies the repo's nixos folder to /etc/nixos on the host, then builds and activates
# the host's flake output there, so the host's own Nix builds it. sudo asks for dan's
# password.
#
# Usage: nixos/rebuild-host.sh <flake host> [ssh target]
# The ssh target defaults to <flake host>.dlab.

host="${1:?flake host, such as cynic}"
target="${2:-$host.dlab}"
repo="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"

# A freshly installed host has no /etc/nixos until its first rebuild declares one.
ssh "$target" test -w /etc/nixos || ssh -t "$target" sudo install -d -o dan -g root -m 0755 /etc/nixos
rsync -a --delete --exclude result "$repo/nixos/" "$target:/etc/nixos/"
ssh -t "$target" "sudo nixos-rebuild switch --flake 'path:/etc/nixos#$host'"
