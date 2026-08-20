# server-ansible

Production-baseline Ansible setup for Nomad/Consul/Vault/Caddy nodes.

## What changed (hardening baseline)

- Services run as dedicated system users (`consul`, `nomad`, `vault`) with stricter systemd sandboxing.
- `apt_key` usage removed; APT repos now use keyrings + `signed-by`.
- Enforced HashiCorp binary checksum verification by default (`enforce_binary_checksums: true`):
  - `nomad_binary_checksum`
  - `consul_binary_checksum`
  - `vault_binary_checksum`
- Consul hardening defaults enabled:
  - ACLs enabled (`consul_acl_enabled: true`)
  - TLS enabled (`consul_tls_enabled: true`)
  - gossip encryption required (`consul_encrypt_enabled: true`)
- Nomad hardening defaults enabled:
  - ACLs enabled (`nomad_acl_enabled: true`)
  - TLS enabled (`nomad_tls_enabled: true`)
- Vault TLS is enabled by default (`vault_tls_disable: false`).
- Vault config now supports explicit TLS file paths and will fail if TLS files are missing.
- Nomad raw_exec plugin now defaults OFF (`nomad_enable_raw_exec: false`).
- Mutable deploy paths are now blocked by default:
  - `scripts/deploy-site.sh` requires `mutable_deploy_ok=true` per site entry.
  - `postgres-garden.nomad` mutable local prestart build removed in favor of immutable image deploys.
- Caddy OTEL CORS policy now allows only explicit origins.
- Vault switched from file storage to Raft storage backend.
- `site.yml` job deployment play now uses `become: true`.
- `deploy-site` Nomad job is no longer auto-deployed from Ansible by default.
- Nomad job rollout is now idempotent (`nomad job plan -detailed-exitcode` + conditional `job run`).
- Added `alerts.nomad` periodic watchdog job with Vault-backed Slack webhook secret (`secret/data/alerts`).
- Infra API now fails closed when `INFRA_API_TOKEN` is missing.
- Webhook-driven auto-promotion is now opt-in via `INFRA_WEBHOOK_AUTO_PROMOTE=true`.
- Compose-managed data/observability ports now bind to localhost by default.
- Infra agent SSH now uses TOFU host key verification (`accept-new`) instead of disabling checks.
- CLI config `*_command` execution is now disabled by default; opt in with `INFRA_ENABLE_CONFIG_COMMANDS=true`.
- Non-local `OPENBAO_ADDR` / `INFRA_SERVER_URL` values must use HTTPS unless `INFRA_ALLOW_INSECURE_HTTP=true` is explicitly set.
- Infra agent API/webhook secrets are now seeded into OpenBao and loaded at runtime instead of being templated into `/opt/infra/.env`.

## Required inventory variables

Set these in inventory/group vars before production apply:

- `nomad_binary_checksum`
- `consul_binary_checksum`
- `vault_binary_checksum`
- `consul_encrypt_key`
- `consul_agent_token`
- `nomad_bootstrap_token`
- `nomad_consul_token`

Format:

```yaml
nomad_binary_checksum: "sha256:<hash>"
consul_encrypt_key: "<base64 gossip key>"
consul_agent_token: "<consul acl token>"
nomad_bootstrap_token: "<nomad management/bootstrap token>"
nomad_consul_token: "<consul acl token for nomad agent>"
```

## Image digest pinning for postgres-garden

`nomad-jobs/postgres-garden.nomad` now expects immutable digests.
Replace placeholders before apply:

```hcl
registry.dfg.rocks/postgresgarden-app@sha256:REPLACE_WITH_REAL_DIGEST
```

Example to get digest from registry (replace host/image/tag):

```bash
docker build -t registry.dfg.rocks/postgresgarden-app:prod-2026-03-06 .
docker push registry.dfg.rocks/postgresgarden-app:prod-2026-03-06
docker inspect --format='{{index .RepoDigests 0}}' registry.dfg.rocks/postgresgarden-app:prod-2026-03-06
```

## Alerts job

`alerts.nomad` runs every 2 minutes and checks:

- postgres.garden (`http://127.0.0.1:3000/`)
- signoz (`http://{{ obs_addr }}:8080/api/v1/health`)
- docker registry (`http://127.0.0.1:5000/v2/`)

On failure it posts to Slack webhook from Vault secret:

```bash
vault kv put secret/alerts slack_webhook_url="https://hooks.slack.com/services/..."
```

## Vault TLS prerequisites

Default expected paths:

- `/etc/vault.d/tls/vault.crt`
- `/etc/vault.d/tls/vault.key`
- `/etc/vault.d/tls/ca.crt`

Override via inventory vars:

- `vault_tls_cert_file`
- `vault_tls_key_file`
- `vault_tls_ca_file`
- `vault_tls_disable` (set to `true` only for explicitly insecure local/testing setups)

Playbook now asserts these files exist when TLS is enabled.

## Infra agent secret bootstrap

The infra agent now expects:

- OpenBao bootstrap token at `~/.config/infra/openbao-token`
- API token cached at `~/.config/infra/api-token`
- webhook secret cached at `~/.config/infra/webhook-secret`

Ansible seeds `infra-agent` secrets into OpenBao during deploy, then the agent hydrates its local cached token files from OpenBao at runtime.
This removes API/webhook secrets from `/opt/infra/.env`, but the OpenBao bootstrap token still remains a sensitive local bootstrap credential.

## Validation

Syntax check:

```bash
ansible-playbook -i inventory/hosts.yml site.yml --syntax-check
```

## Important note

This is a production **baseline**, not full HA posture yet.
You still need multi-node quorum, ACL/mTLS rollout for Consul/Nomad/Vault, and offsite encrypted backups + restore drills.
