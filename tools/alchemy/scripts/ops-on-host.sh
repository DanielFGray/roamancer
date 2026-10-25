#!/bin/sh
# Runs on the control host, the machine with the Nomad server, OpenBao and the
# Alchemy state. Usage: ops-on-host.sh <command> [args...]
#   plan, deploy, destroy, drift, state: Alchemy's own commands, for example
#     `deploy --stage giglist`. All but state need an OpenBao token from `login`.
#   anything else: src/cli.ts (login, check-login, secret, status, logs). `--help` lists them.
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
# `login` writes this file; the other commands read the token from it.
export OPENBAO_TOKEN_FILE="$XDG_RUNTIME_DIR/openbao.token"
if [ -r "$OPENBAO_TOKEN_FILE" ]; then
  OPENBAO_TOKEN="$(cat "$OPENBAO_TOKEN_FILE")"
  export OPENBAO_TOKEN
fi
# The value of --stage (or --stage=<value>) among the arguments; empty without one.
stage() {
  while [ $# -gt 0 ]; do
    case "$1" in
      --stage) printf %s "${2:-}"; return ;;
      --stage=*) printf %s "${1#--stage=}"; return ;;
    esac
    shift
  done
}

case "${1:-}" in
  plan | deploy)
    # A task whose secret is unset waits on its template forever, so the deploy fails
    # only at its timeout and leaves a failed version behind. Refuse first. The check
    # also fails on an expired OpenBao token.
    bun src/cli.ts secret check "$(stage "$@")"
    exec bunx alchemy "$@"
    ;;
  destroy | drift)
    # These read OpenBao, and Alchemy reports an expired token deep inside a provider
    # call, so check it first.
    bun src/cli.ts check-login
    exec bunx alchemy "$@"
    ;;
  state)
    exec bunx alchemy "$@"
    ;;
  *)
    exec bun src/cli.ts "$@"
    ;;
esac
