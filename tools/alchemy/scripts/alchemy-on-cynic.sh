#!/bin/sh
# Usage on cynic: alchemy-on-cynic.sh <plan|deploy> <stage> <cartridge path relative to ~/alchemy>
set -eu
cd ~/alchemy
# The controller env file is readable by the alchemy group after
# `nomad-acl-issue-controller` has been run once with the group present.
if [ ! -r /var/lib/nomad-acl/controller.env ]; then
  echo "cannot read /var/lib/nomad-acl/controller.env." >&2
  echo "Run 'sudo nomad-acl-issue-controller' once after the rebuild so the" >&2
  echo "env file becomes group-readable by the alchemy group." >&2
  exit 1
fi
eval "$(sed "s/^/export /" /var/lib/nomad-acl/controller.env)"
export NOMAD_ADDR=http://127.0.0.1:4646 OPENBAO_ADDR=http://127.0.0.1:8200
export OPENBAO_TOKEN="$(cat /run/user/1000/cynic-bao.token)" ALCHEMY_CARTRIDGE="$PWD/$3"
exec nix --extra-experimental-features "nix-command flakes" shell nixpkgs/cd4ea8d57de16f4810bc5f14207bac45fbf19f67#bun -c bun run "$1" --stage "$2" --yes
