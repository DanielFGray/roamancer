#!/usr/bin/env bash
set -euo pipefail

# Creates the OpenBao mounts the platform expects, after the store is initialized and
# unsealed. Safe to run again: it only adds what is missing.
#
#   secret/     KV v2. App and platform values under secret/data/<project>.
#   database/   The PostgreSQL engine. Alchemy writes each server's connection and roles.
#   jwt-nomad/  Nomad workload identities log in here. Alchemy writes one role per job;
#               the auth method has no default role, so a job without one gets nothing.
#
# Usage: BAO_ADDR=http://127.0.0.1:8200 BAO_TOKEN_FILE=... openbao-platform.sh
# Run it through the SSH tunnel in openbao-operations.md. The token needs root-level
# rights over sys/mounts and sys/auth, so use a short-lived child of the root token.

export BAO_TOKEN="$(cat "${BAO_TOKEN_FILE:?file holding an OpenBao token}")"
: "${BAO_ADDR:?OpenBao address, such as http://127.0.0.1:8200}"

mounts="$(bao secrets list -format=json)"
auths="$(bao auth list -format=json)"
has() { jq -e --arg p "$2/" 'has($p)' <<<"$1" >/dev/null; }

has "$mounts" secret || bao secrets enable -path=secret -version=2 kv
has "$mounts" database || bao secrets enable database
has "$auths" jwt-nomad || bao auth enable -path=jwt-nomad jwt
# Nomad serves its workload-identity signing keys on its loopback API.
bao write auth/jwt-nomad/config \
  jwks_url=http://127.0.0.1:4646/.well-known/jwks.json \
  jwt_supported_algs=RS256,EdDSA \
  default_role=
