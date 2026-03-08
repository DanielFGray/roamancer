# Ansible + Infra Tool Boundary Design

## Problem

The Caddyfile contains hardcoded routes for specific projects (danielfgray.com, postgres.garden, dfg.codes, etc.). The infra tool manages project routes via the Caddy admin API. These two systems conflict: Caddyfile reloads could clobber admin API routes, and adding new projects requires editing Ansible templates.

Compose services (Postgres, Valkey, SigNoz) exist in the repo but aren't deployed by the playbook.

The infra agent has no Ansible role for deployment.

## Decision

Split responsibilities cleanly:

- **Ansible** = base infrastructure (OS, runtimes, daemons, infra routes, compose services, infra agent)
- **Infra tool** = project lifecycle (deploy, Caddy project routes, systemd units, env files, secrets, ports)

## Ansible Responsibilities

### Roles

1. **common** — packages, users (dan, prod), Bun, base directories
2. **podman** — container runtime (replaces Docker)
3. **vault** — OpenBao on obs node
4. **caddy** — install Caddy, deploy Caddyfile with infrastructure-only routes
5. **compose** (new) — deploy compose services (Postgres+Valkey on web, SigNoz on obs)
6. **infra-agent** (new) — rsync built bundle, systemd unit, env file

### Caddyfile Contents (After Cleanup)

Infrastructure routes only:

- **SigNoz**: `signoz.dfg.codes` → `atheist.dlab:8080` + OTEL endpoints
- **OTEL**: `otel.dfg.codes` → `atheist.dlab:4318` with CORS
- **Infra API**: `infra.dfg.codes` → `localhost:{API_PORT}`
- **Git redirects**: `git.dfg.codes`, `git.danielfgray.com` → GitHub

Removed: all project site routes (danielfgray.com, dfg.codes, dfg.rocks, postgres.garden, pg-sourcerer.dfg.codes, eddie.dfg.rocks).

The `(static)` and `(otel_cors)` snippets stay — `(static)` will be used by infra tool routes too (Caddy snippets are available to admin API routes).

### Compose Services

- **web node**: `services/infra/compose.yml` (Postgres + Valkey)
- **obs node**: `services/signoz/compose.yml` (SigNoz stack)

Deployed via `podman-compose up -d` in the playbook.

### Infra Agent Role

- Rsync pre-built bundle from local machine to `/opt/infra/` on web node
- Install systemd unit (`infra-agent.service`)
- Template env file to `/opt/infra/.env` (OPENBAO_TOKEN, INFRA_API_TOKEN, WEBHOOK_SECRET, etc.)
- Start and enable the service

## Infra Tool Responsibilities

All project Caddy routes via admin API (`@id` prefixed with `infra/`). All project systemd services. All project env files, secrets, port allocation. Full deploy/promote/rollback/teardown lifecycle.

The CaddyManager already handles this — it reads existing routes, filters out `infra/`-prefixed ones, and writes back the merged array. Infrastructure routes from the Caddyfile are preserved because they don't have the `infra/` prefix.

## Hosts

- **web01** (`cynic.dlab`): common, podman, caddy, compose (pg+valkey), infra-agent
- **obs01** (`atheist.dlab`): common, podman, vault, compose (signoz)

## site.yml Structure

```yaml
- name: Base setup for all VMs
  hosts: all
  become: true
  roles:
    - common
    - podman

- name: OpenBao on obs node
  hosts: obs
  become: true
  roles:
    - vault

- name: Caddy on web node
  hosts: web
  become: true
  roles:
    - caddy

- name: Compose services on web node
  hosts: web
  become: true
  tasks:
    - name: Deploy infra compose services
      # podman-compose up for Postgres + Valkey

- name: SigNoz on obs node
  hosts: obs
  become: true
  tasks:
    - name: Deploy SigNoz compose stack
      # podman-compose up for SigNoz

- name: Infra agent on web node
  hosts: web
  become: true
  roles:
    - infra-agent
```

## Key Constraints

- Caddy admin API must be enabled in the global config (`admin localhost:2019`)
- Caddyfile reload does not clobber admin API routes (Caddy merges them)
- The `(static)` snippet must remain in the Caddyfile — admin API routes can reference it
- Infra agent needs Bun runtime (installed by common role) and network access to obs node (for OpenBao)
- Compose `.env` files need secrets from OpenBao (provisioned manually or via infra tool bootstrap)
