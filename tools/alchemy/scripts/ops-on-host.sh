#!/bin/sh
# Runs on the control host, the machine with the Nomad server, OpenBao and the
# Alchemy state. Usage: ops-on-host.sh <command> [args...]
#   plan, deploy, destroy, drift, state: Alchemy's own commands, for example
#     `deploy --stage giglist`. All but state need an OpenBao token from `login`.
#   rollback <name> <id>: deploy a recorded deployment again, and record it as the newest.
#   anything else: src/cli.ts (login, check-login, secret, dash, status, logs, deployment).
#     `--help` lists them.
# An app's cartridge comes from CARTRIDGE_FILE when `ops` sent one, otherwise from the
# newest recorded deployment (src/Cartridge.ts, resolve). A deploy that was sent a
# cartridge records it once Alchemy succeeds.
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

# Plan or deploy one stage. A sent app cartridge must pin its images and come from the
# repository the app was first deployed from; a deploy of one is recorded once it succeeds.
plan_or_deploy() {
  name=$(stage "$@")
  # Only a release or rollback sends ORIGIN with the cartridge. A staged instance is sent
  # without it, because it is never the deployed version.
  recorded=
  if [ "${CARTRIDGE_FILE+x}" = x ] && [ "${ORIGIN+x}" = x ]; then
    bun src/cli.ts deployment check "$name"
    recorded=1
  fi
  # A task whose secret is unset waits on its template forever, so the deploy fails
  # only at its timeout and leaves a failed version behind. Refuse first. The check
  # also fails on an expired OpenBao token.
  bun src/cli.ts secret check "$name"
  bunx alchemy "$@"
  if [ -n "$recorded" ] && [ "$1" = deploy ]; then bun src/cli.ts deployment record "$name"; fi
}

case "${1:-}" in
  plan | deploy)
    plan_or_deploy "$@"
    ;;
  rollback)
    name=${2:?usage: rollback <name> <id>}
    id=${3:?usage: rollback <name> <id>}
    mkdir -p .alchemy/input
    CARTRIDGE_FILE=".alchemy/input/rollback-$name-$id.json"
    export CARTRIDGE_FILE
    # Prints ORIGIN=<root commit> REVISION=<commit>: git object names, safe to evaluate.
    eval "export $(bun src/cli.ts deployment restore "$name" "$id" "$CARTRIDGE_FILE")"
    plan_or_deploy deploy --stage "$name"
    ;;
  destroy)
    # Destroy is defined by persisted state and must not evaluate the cartridge.
    bun src/cli.ts check-login
    exec bunx alchemy "$@" -c state.run.ts
    ;;
  drift)
    # Drift reads OpenBao, and Alchemy reports an expired token deep inside a provider
    # call, so check it first.
    bun src/cli.ts check-login
    exec bunx alchemy "$@"
    ;;
  state)
    # State commands read the store only; the state-only entry needs no cartridge or image.
    exec bunx alchemy "$@" -c state.run.ts
    ;;
  *)
    exec bun src/cli.ts "$@"
    ;;
esac
