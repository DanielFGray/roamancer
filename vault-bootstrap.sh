#!/usr/bin/env bash
set -euo pipefail

# Run this ONCE after Vault starts for the first time.
# It initializes Vault, unseals it, enables the KV engine,
# creates policies for Nomad, and seeds secrets.
#
# SAVE THE UNSEAL KEYS AND ROOT TOKEN SOMEWHERE SAFE.
#
# To import secrets from existing .env files instead of CHANGE_ME:
#   source ~/build/postgres.garden/.env
#   Then replace CHANGE_ME values below with the shell variables.

export VAULT_ADDR="http://127.0.0.1:8200"

echo "=== Initializing Vault ==="
vault operator init -key-shares=1 -key-threshold=1 -format=json > /tmp/vault-init.json

UNSEAL_KEY=$(jq -r '.unseal_keys_b64[0]' /tmp/vault-init.json)
ROOT_TOKEN=$(jq -r '.root_token' /tmp/vault-init.json)

echo "=== Unsealing ==="
vault operator unseal "$UNSEAL_KEY"
export VAULT_TOKEN="$ROOT_TOKEN"

echo "=== Enabling KV secrets engine ==="
vault secrets enable -path=secret kv-v2

echo "=== Creating Nomad server policy ==="
vault policy write nomad-server - <<'POLICY'
path "auth/token/create/nomad-cluster" { capabilities = ["update"] }
path "auth/token/roles/nomad-cluster"  { capabilities = ["read"] }
path "auth/token/lookup-self"          { capabilities = ["read"] }
path "auth/token/lookup"               { capabilities = ["update"] }
path "auth/token/revoke-accessor"      { capabilities = ["update"] }
path "sys/capabilities-self"           { capabilities = ["update"] }
path "auth/token/renew-self"           { capabilities = ["update"] }
POLICY

echo "=== Creating app policies ==="
vault policy write infra - <<'POLICY'
path "secret/data/infra" { capabilities = ["read"] }
POLICY

vault policy write postgres-garden - <<'POLICY'
path "secret/data/postgres-garden" { capabilities = ["read"] }
POLICY

vault policy write backups - <<'POLICY'
path "secret/data/infra" { capabilities = ["read"] }
path "sys/storage/raft/snapshot" { capabilities = ["read"] }
POLICY

echo "=== Creating Nomad token role ==="
vault write auth/token/roles/nomad-cluster \
  disallowed_policies="nomad-server" \
  token_explicit_max_ttl=0 \
  orphan=true \
  token_period="259200" \
  renewable=true

echo "=== Creating Nomad server token ==="
NOMAD_VAULT_TOKEN=$(vault token create -policy nomad-server -period 72h -orphan -format=json | jq -r '.auth.client_token')
echo ""
echo "Add this to /etc/nomad.d/nomad.hcl vault block:"
echo "  token = \"$NOMAD_VAULT_TOKEN\""
echo ""

echo "=== Seeding secrets ==="
echo "You'll need to populate these with real values:"
echo ""

vault kv put secret/infra \
  postgres_user="postgres" \
  postgres_password="CHANGE_ME"

vault kv put secret/postgres-garden \
  root_database_user="postgres" \
  root_database_password="CHANGE_ME" \
  root_database_url="postgres://postgres:CHANGE_ME@postgres.service.consul:5432/postgres" \
  database_host="postgres.service.consul" \
  database_port="5432" \
  database_name="postgres_garden" \
  database_owner="pg_garden_owner" \
  database_owner_password="CHANGE_ME" \
  database_url="postgres://pg_garden_owner:CHANGE_ME@postgres.service.consul:5432/postgres_garden" \
  database_authenticator="pg_garden_auth" \
  database_authenticator_password="CHANGE_ME" \
  shadow_database_password="CHANGE_ME" \
  shadow_database_url="postgres://postgres:CHANGE_ME@postgres.service.consul:5432/postgres_garden_shadow" \
  auth_database_url="postgres://pg_garden_auth:CHANGE_ME@postgres.service.consul:5432/postgres_garden" \
  database_visitor="pg_garden_visitor" \
  secret="CHANGE_ME" \
  valkey_url="redis://valkey.service.consul:6379" \
  vite_root_url="https://postgres.garden" \
  otel_exporter_otlp_endpoint="http://otel-collector.service.consul:4318" \
  vite_otel_collector_url="https://otel.dfg.codes" \
  github_client_id="CHANGE_ME" \
  github_client_secret="CHANGE_ME"

echo ""
echo "=== Done ==="
echo ""
echo "IMPORTANT: Save these securely and delete /tmp/vault-init.json"
echo "  Unseal Key:  $UNSEAL_KEY"
echo "  Root Token:  $ROOT_TOKEN"
echo "  Nomad Token: $NOMAD_VAULT_TOKEN"
