# Ansible + Infra Tool Boundary Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Remove all hardcoded project routes/services from Ansible. Ansible provisions base infrastructure only. The infra tool manages all project lifecycle (routes, services, env files, secrets, ports).

**Architecture:** Ansible handles OS setup, runtimes, daemons (Caddy, OpenBao), compose services (Postgres, Valkey, SigNoz), and the infra agent itself. The infra tool manages project Caddy routes via the admin API (`@id` prefixed `infra/`), systemd units, env files, secrets, and port allocation. The Caddyfile contains only infrastructure routes (SigNoz, OTEL, infra API, git redirects).

**Tech Stack:** Ansible (YAML playbooks), Jinja2 templates, Caddy, podman-compose, systemd

**Reference:** `docs/plans/2026-03-08-ansible-infra-boundary-design.md`

---

### Task 1: Strip project routes from Caddyfile template

**Files:**

- Modify: `roles/caddy/templates/Caddyfile.j2`

**Step 1: Replace the Caddyfile template**

Remove all project site blocks. Keep snippets, SigNoz/OTEL routes, git redirects. Add infra API route and Caddy admin API global option.

New content for `roles/caddy/templates/Caddyfile.j2`:

```caddy
{
	admin localhost:2019
}

# Reusable snippets — available to both Caddyfile and admin API routes

(static) {
	root * {args[0]}
	try_files {path} /index.html
	file_server
}

(otel_cors) {
	@allowed_origin expression `{http.request.header.Origin} == "https://postgres.garden" || {http.request.header.Origin} == "https://otel.dfg.codes" || {http.request.header.Origin} == "https://signoz.dfg.codes"`
	@preflight method OPTIONS
	handle @preflight @allowed_origin {
		header Access-Control-Allow-Origin "{http.request.header.Origin}"
		header Access-Control-Allow-Methods "GET, POST, OPTIONS"
		header Access-Control-Allow-Headers "content-type, x-requested-with"
		header Access-Control-Max-Age "3600"
		respond 204
	}
	handle @preflight {
		respond 403
	}

	header @allowed_origin Access-Control-Allow-Origin "{http.request.header.Origin}"
	header @allowed_origin Access-Control-Allow-Methods "GET, POST, OPTIONS"
	header @allowed_origin Access-Control-Allow-Headers "content-type, x-requested-with"
	header @allowed_origin Access-Control-Max-Age "3600"
}

# ─── Infrastructure routes ─────────────────────────────────

signoz.dfg.codes {
	handle /v1/* {
		import otel_cors
		reverse_proxy {{ obs_addr }}:4318
	}
	handle {
		reverse_proxy {{ obs_addr }}:8080
	}
}

otel.dfg.codes {
	import otel_cors
	reverse_proxy {{ obs_addr }}:4318
}

# ─── Redirects ──────────────────────────────────────────────

git.dfg.codes {
	redir https://github.com/DanielFGray{uri} permanent
}

git.danielfgray.com {
	redir https://github.com/DanielFGray{uri} permanent
}
```

Note: the infra API route is intentionally omitted from the Caddyfile — it listens on port 9000 and is accessed directly (not via Caddy) since it runs on the same host. If you want it behind Caddy later, the infra tool can add it via admin API.

**Step 2: Verify template syntax**

```bash
cd /home/dan/build/server-ansible
grep -c '{{' roles/caddy/templates/Caddyfile.j2  # Should show 2 (obs_addr references)
```

**Step 3: Commit**

```bash
git add roles/caddy/templates/Caddyfile.j2
git commit -m "caddy: strip project routes, keep infra-only routes

Caddyfile now only contains SigNoz, OTEL, and git redirects.
Project routes are managed by the infra tool via Caddy admin API.
Enables admin API on localhost:2019."
```

---

### Task 2: Create compose role for service deployment

**Files:**

- Create: `roles/compose/tasks/main.yml`

**Step 1: Create the role directory**

```bash
mkdir -p roles/compose/tasks
```

**Step 2: Write the tasks file**

Create `roles/compose/tasks/main.yml`:

```yaml
---
- name: Copy compose files to host
  copy:
    src: "{{ item.src }}"
    dest: "{{ item.dest }}"
    owner: root
    group: root
    mode: "0644"
  loop: "{{ compose_stacks }}"
  loop_control:
    label: "{{ item.name }}"

- name: Copy supporting files
  copy:
    src: "{{ item.src }}"
    dest: "{{ item.dest }}"
    owner: root
    group: root
    mode: "0644"
  loop: "{{ compose_extra_files | default([]) }}"
  loop_control:
    label: "{{ item.dest }}"
  when: compose_extra_files is defined

- name: Template .env files
  template:
    src: "{{ item.env_template }}"
    dest: "{{ item.dest | dirname }}/.env"
    owner: root
    group: root
    mode: "0600"
  loop: "{{ compose_stacks }}"
  loop_control:
    label: "{{ item.name }}"
  when: item.env_template is defined

- name: Start compose stacks
  command: podman-compose up -d
  args:
    chdir: "{{ item.dest | dirname }}"
  loop: "{{ compose_stacks }}"
  loop_control:
    label: "{{ item.name }}"
  register: compose_result
  changed_when: "'Creating' in compose_result.stdout or 'Recreating' in compose_result.stdout"
```

**Step 3: Commit**

```bash
git add roles/compose/
git commit -m "ansible: add compose role for podman-compose service deployment"
```

---

### Task 3: Create infra-agent role

**Files:**

- Create: `roles/infra-agent/tasks/main.yml`
- Create: `roles/infra-agent/templates/infra-agent.service.j2`
- Create: `roles/infra-agent/templates/infra-agent.env.j2`
- Create: `roles/infra-agent/handlers/main.yml`

**Step 1: Create role directories**

```bash
mkdir -p roles/infra-agent/{tasks,templates,handlers}
```

**Step 2: Write the systemd unit template**

Create `roles/infra-agent/templates/infra-agent.service.j2`:

```ini
[Unit]
Description=Infra deployment agent
After=network-online.target caddy.service
Wants=network-online.target

[Service]
Type=simple
User=prod
Group=web
WorkingDirectory=/opt/infra
ExecStart=/home/prod/.bun/bin/bun run /opt/infra/server/main.ts
EnvironmentFile=-/opt/infra/.env
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
```

**Step 3: Write the env file template**

Create `roles/infra-agent/templates/infra-agent.env.j2`:

```bash
# Infra agent configuration — managed by Ansible
OPENBAO_ADDR={{ vault_addr }}
OPENBAO_TOKEN={{ infra_openbao_token | default('') }}
INFRA_API_TOKEN={{ infra_api_token | default('') }}
INFRA_WEBHOOK_SECRET={{ infra_webhook_secret | default('') }}
INFRA_API_PORT={{ infra_api_port | default('9000') }}
```

**Step 4: Write the tasks file**

Create `roles/infra-agent/tasks/main.yml`:

```yaml
---
- name: Create infra agent directory
  file:
    path: /opt/infra
    state: directory
    owner: prod
    group: web
    mode: "0775"

- name: Rsync infra agent bundle
  synchronize:
    src: "{{ playbook_dir }}/tools/infra/"
    dest: /opt/infra/
    rsync_opts:
      - "--exclude=node_modules"
      - "--exclude=.git"
      - "--exclude=docs"
    delete: true
  notify: restart infra-agent

- name: Install bun dependencies
  command: /home/prod/.bun/bin/bun install --frozen-lockfile
  args:
    chdir: /opt/infra
  become_user: prod
  register: bun_install
  changed_when: "'Saved lockfile' not in bun_install.stderr"

- name: Deploy infra agent env file
  template:
    src: infra-agent.env.j2
    dest: /opt/infra/.env
    owner: prod
    group: web
    mode: "0600"
  notify: restart infra-agent

- name: Deploy infra agent systemd unit
  template:
    src: infra-agent.service.j2
    dest: /etc/systemd/system/infra-agent.service
    mode: "0644"
  notify: restart infra-agent

- name: Start infra agent
  systemd:
    name: infra-agent
    state: started
    enabled: true
    daemon_reload: true
```

**Step 5: Write the handlers file**

Create `roles/infra-agent/handlers/main.yml`:

```yaml
---
- name: restart infra-agent
  systemd:
    name: infra-agent
    state: restarted
    daemon_reload: true
```

**Step 6: Commit**

```bash
git add roles/infra-agent/
git commit -m "ansible: add infra-agent role (rsync, systemd, env file)"
```

---

### Task 4: Update site.yml with new plays

**Files:**

- Modify: `site.yml`

**Step 1: Rewrite site.yml**

```yaml
---
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
  roles:
    - role: compose
      vars:
        compose_stacks:
          - name: infra
            src: services/infra/compose.yml
            dest: /opt/services/infra/compose.yml
            env_template: ../../services/infra/.env.j2

- name: SigNoz on obs node
  hosts: obs
  become: true
  roles:
    - role: compose
      vars:
        compose_stacks:
          - name: signoz
            src: services/signoz/compose.yml
            dest: /opt/services/signoz/compose.yml
        compose_extra_files:
          - src: services/signoz/otel-collector-config.yaml
            dest: /opt/services/signoz/otel-collector-config.yaml

- name: Infra agent on web node
  hosts: web
  become: true
  roles:
    - infra-agent
```

**Step 2: Create the infra .env.j2 template**

Create `services/infra/.env.j2`:

```bash
POSTGRES_USER={{ infra_postgres_user | default('postgres') }}
POSTGRES_PASSWORD={{ infra_postgres_password }}
```

**Step 3: Commit**

```bash
git add site.yml services/infra/.env.j2
git commit -m "ansible: update site.yml with compose and infra-agent plays"
```

---

### Task 5: Update inventory with new variables

**Files:**

- Modify: `inventory/hosts.yml`

**Step 1: Add infra agent variables**

```yaml
all:
  children:
    web:
      hosts:
        web01:
          ansible_host: cynic.dlab
          caddy_enabled: true

    obs:
      hosts:
        obs01:
          ansible_host: atheist.dlab

  vars:
    ansible_user: dan
    ansible_python_interpreter: /usr/bin/python3
    obs_addr: "{{ hostvars['obs01']['ansible_host'] }}"
    vault_addr: "http://{{ obs_addr }}:8200"
    vault_version: "2.1.0"
    infra_api_port: 9000
```

Note: Secrets (`infra_openbao_token`, `infra_api_token`, `infra_webhook_secret`, `infra_postgres_password`) should be passed via `--extra-vars`, an Ansible vault file, or a `group_vars/all/vault.yml`. Do NOT commit them to inventory.

**Step 2: Commit**

```bash
git add inventory/hosts.yml
git commit -m "ansible: add infra_api_port to inventory vars"
```

---

### Task 6: Dry-run validation

**Step 1: Run ansible-playbook syntax check**

```bash
cd /home/dan/build/server-ansible
ansible-playbook site.yml --syntax-check
```

Expected: `playbook: site.yml` (no errors)

**Step 2: Run ansible-playbook dry run (if VMs are reachable)**

```bash
ansible-playbook site.yml --check --diff
```

Expected: shows planned changes without applying them.

**Step 3: Commit any fixes needed**

---

### Task 7: Verify Caddy admin API compatibility

After deploying to the VM, verify the infra tool's CaddyManager works with the new Caddyfile.

**Step 1: Verify Caddy admin API is enabled**

```bash
ssh prod@cynic.dlab "curl -s http://localhost:2019/config/ | jq '.apps.http.servers.srv0.listen'"
```

Expected: `[":443"]` or similar — confirms admin API is live and the server exists.

**Step 2: Verify infra tool can add routes**

Deploy a test project via the infra tool and verify the route appears in Caddy config:

```bash
ssh prod@cynic.dlab "curl -s http://localhost:2019/config/apps/http/servers/srv0/routes | jq '.[].\"@id\"'"
```

Expected: shows `infra/`-prefixed route IDs for the deployed project alongside infrastructure routes (which have no `@id`).

---
