# server-ansible

A small deployment platform for self-hosted apps on a few NixOS machines. You describe an app in a
`cartridge.json` file in its repository. One command builds its image, pushes it to a private
registry, and deploys it. The result is a Nomad job that rootless Podman runs, with routes, secrets,
and database credentials already wired in.

This is experimental software that one person runs on their own machines. [Status](#status) lists
what has been tested and what is open.

## How it works

Four tools share the work, and each one owns a layer:

| Layer | Tool | Owns |
| --- | --- | --- |
| Hosts | NixOS | the operating system, rootless Podman, Nomad, host volumes, the firewall |
| Scheduling | Nomad | where each container runs, its health checks, restarts |
| Desired state | [Alchemy](https://alchemy.run) | the Nomad jobs, routes, and database logins an app declares |
| Secrets | OpenBao | passwords and keys; an app's files hold references, never values |

Around those:

- **Traefik** is the only public entry point. It runs as a Nomad job, terminates TLS, and reads each
  route from the tags on the Nomad service, so a moved container keeps its route.
- **PostgreSQL and Valkey** run once, as a shared `platform-data` cartridge. An app asks for a
  database or a key prefix, and the platform creates the login.
- **Staged releases** run a candidate beside the live release at a preview address. You promote it
  or roll back by changing which release is selected. The staged copy gets its own databases and
  refuses a service that writes a host volume.
- **Tailscale Serve** can publish a route on your tailnet only, with no public DNS.

A **cartridge** is a versioned JSON file that lists an app's services, images, ports, volumes,
routes, secret references, and database needs. The platform turns each service into one Nomad job
and orders the jobs by their dependencies.

`ops release`, `ops stage` and `ops promote` build an app's committed `HEAD` and push it to the
cluster registry. The build is a Nomad batch job on a worker node: `ops` sends the exported tree
to the runner on the control host, which uploads it to the `builds` bucket and runs Buildah in
the builder user's rootless Podman. The runner records the digest only after the registry
answers for it. The build uses the repository's `Dockerfile`, even when a `Containerfile` sits
beside it.

## What you get

Releases:

- `ops release` builds the app repository's committed `HEAD`, pushes the image to the private
  registry, pins it by digest, shows the plan, and deploys after you confirm.
- Each deployment is recorded. `ops rollback <app> <n>` deploys an earlier one again, image and
  job together.
- `ops stage` runs a candidate at a tailnet-only preview address beside the live release.
  `ops promote` releases that exact image, and `ops discard` removes it.
- An update waits for the new container's health checks. Nomad is set to revert an update that
  fails them.
- A service's `migrate` step runs before the service starts, and a failed migration keeps the new
  release from starting.

Secrets:

- Cartridges and Alchemy state hold secret references, never values.
- Each job gets its own OpenBao role and policy, derived from its name. Nomad logs the job in with
  a workload identity, so no secret token sits on disk.
- Nomad restarts a task when a secret it reads changes.
- `ops secret list` and `ops secret check` show which referenced keys are set, never their values.
  A deploy fails early when a key is missing.

Data:

- An app that declares a `postgres` entry gets a database, owner and visitor roles, and
  short-lived logins from OpenBao: one for migrations and one for the API. The API login uses
  `SET ROLE` to the visitor role, so row-level security applies.
- The platform creates the extensions an app lists before its migrations run. The image includes
  pgvector, pgTAP, pgsodium and pg_hashids.
- An app that declares `valkey` gets an ACL user that can reach only keys that start with its
  own prefix. An environment entry `{ "name": "VALKEY_KEY_PREFIX", "valkey": "keyPrefix" }` gives
  the app that prefix, such as `giglist:`, and a staged copy gets its own, `giglist-staged:`.
- An app can reach only the databases, secrets, volumes and service names in its own namespace,
  which comes from its name.

Traffic and operations:

- Traefik reads routes from Nomad service tags, so a route follows a container that moves to
  another host. A route can also be on the tailnet only, through Tailscale Serve.
- Every node runs an OpenTelemetry collector that sends traces, logs and metrics to OpenObserve.
- `ops logs`, `ops status` and `ops dash` show task output, allocations, health, and each node's
  memory and reservations.
- `ops deploy` refuses a plan that is out of date, and the host runs only the runner code that the
  last `ops rebuild` installed.

Hosts and development:

- Each host is a NixOS system built from this flake, with nixpkgs pinned. `ops rebuild` makes a
  new system generation that you can roll back to, and `ops install` sets up a new machine.
- Containers run under rootless Podman, and restic backs up each host.
- `ops dev db` gives an app's local checkout its own dev, shadow and test databases on a
  separate dev Postgres server, through an SSH tunnel, so dev work cannot use up the live
  server's connections or memory.

## What you need

- Two or more x86_64 machines that run NixOS. The shared host modules assume Proxmox-style virtual
  machines (SeaBIOS, virtio disks and network); change `nixos/modules/proxmox-vm.nix` and
  `disk-config.nix` for other hardware.
- A workstation with `bun`, `docker`, `git`, and `ssh`. Docker runs the Nix builds, so the
  workstation needs no Nix. `ops dev db` also needs `psql` and a systemd user session, which
  keeps its SSH tunnel.
- SSH access to each machine, with host names set in `~/.ssh/config`.

### What the stack runs

NixOS installs and configures the host services. The platform cartridges run the rest as Nomad
jobs.

| Where | Component | Source |
| --- | --- | --- |
| Every host | Nomad client, rootless Podman, Tailscale, OpenSSH, git | `nixos/modules/base.nix`, `nomad-node.nix` |
| Control host (cynic) | Nomad server, OpenBao, image registry (`registry.cluster:5000`), cluster CA, Alchemy job runner (`bun`), restic backups | `nixos/cynic/` |
| Ingress host (atheist) | Caddy for static sites, restic backups | `nixos/atheist/`, `nixos/modules/static-sites.nix` |
| Nomad job | PostgreSQL 17 (Nix-built image with pg_hashids, pgTAP, pgvector, pgsodium), Valkey | `tools/alchemy/platform/data` |
| Nomad job | PostgreSQL 17 for `ops dev db` (the same image), on the node that `[devdb] node` names | `tools/alchemy/platform/dev-data` |
| Nomad job | Traefik | `tools/alchemy/platform/ingress` |
| Nomad job | OpenObserve, OpenTelemetry Collector (one per node) | `tools/alchemy/platform/observability` |

`base.nix` also installs the operator's shell tools (ripgrep, fd, neovim and others) and
`herdr.nix` installs herdr. The platform does not use them.

### Memory

A job's `memoryMB` is both what Nomad reserves for it and its hard limit. Nomad places a job only
on a node with that much unreserved memory. Each host's Nomad client also keeps a `reserved`
amount for the host services (`nixos/<host>/nomad.nix`), which no job can take. Together they set
the minimum:

| | Platform jobs (`memoryMB`) | Host reserve | Minimum |
| --- | --- | --- | --- |
| Control host | Postgres 512, Valkey 128, Garage 256, collector 256: 1152 MB | 768 MB (Nomad, OpenBao, job runner, registry, journald, Tailscale, kernel) | 2 GB plus the apps' `memoryMB` |
| Ingress host | Traefik 256, OpenObserve 768, collector 256: 1280 MB | 512 MB (Nomad, journald, Caddy, Tailscale) | 2 GB plus the apps' `memoryMB` |

The two-host layout therefore needs about 4 GB before any app; one host that runs everything needs
about 3 GB. When you use `ops dev db`, the dev Postgres server (`platform-dev-data`, 512 MB) adds
to the host that `[devdb] node` names, the control host by default. Valkey stops accepting writes
at 48 MB (`maxmemory`, `noeviction`), so a log rewrite, which can briefly double its data, stays
under its 128 MB limit. Measured on 2026-11-01.

Nomad reads a host's memory when its agent starts. On a virtual machine with memory ballooning,
the hypervisor can take memory back later, so give each host a guaranteed minimum (on Proxmox,
Minimum memory) at least as large as what its jobs and reserve need, and set the client's
`memory_total_mb` to that minimum. Here cynic is guaranteed 4096 MB and atheist 5120 MB.

## Configure your installation

The values that belong to one installation are in a *site folder*: the LAN and registry addresses,
the operator account and its SSH keys, the ingress machine's public address and network cards, and
the Traefik routes for static sites. `nixos/site` holds placeholder values. Host folder names and
`testground/` still hold some installation-specific names (see [Status](#status)).

1. Copy `nixos/site` to a private git repository and commit it. Edit `site.toml` and the files under `routes/`.
   Edit `policy.toml` too: it names the app repositories the control host watches and whether a push to
   `main` releases them (`deploy = "auto"` or `"manual"`). It reaches the host only through `ops rebuild`,
   so an agent that can push to an app repository cannot widen what releases unattended.
   Do not put secrets there, because the Nix store is readable by every user on a host.
2. Set `OPS_SITE` to that folder in your shell.

The flakes read `site.toml` when Nix builds a host, so a running host never reads it. `ops` sends
only commits: `ops rebuild` and every host command push the commit at `HEAD` of this repository
(and, for `rebuild`, of the site folder) to the host, and `ops install` builds from those two
commits. Uncommitted changes stay on your machine, so you can keep a dirty working tree and deploy
what you committed. For a direct build of the root flake, pass the site folder yourself:

```sh
nix build .#nixosConfigurations.cynic.config.system.build.toplevel --override-input site path:$OPS_SITE
```

Each host keeps its checkouts in the operator's home folder: `~/server-ansible` and `~/site`.
`nixos/modules/deploy-repos.nix` creates them at boot when they are missing. Git pushes to
them with `receive.denyCurrentBranch=updateInstead`, which refuses a push when someone has
edited a tracked file on the host. On the control host, `~/alchemy` is a link to
`~/server-ansible/tools/alchemy`, so Alchemy's state stays at `~/alchemy/.alchemy`.
A control host from the earlier layout has `~/alchemy` as a real folder: move its `.alchemy` and
`node_modules` into `~/server-ansible/tools/alchemy` and remove it. The next rebuild then links it.

`ops` reaches each machine by its host name, the same name as its `nixosConfigurations` entry
(`ssh cynic`). Put the address, port, and user in
`~/.ssh/config`, for example:

```
Host cynic
  HostName 192.168.50.10
Host atheist
  HostName 192.168.50.11
  Port 22
```

Set `OPS_HOST` to use a control host other than `cluster.server`.

## Install and operate

1. Install a host. This erases its disk:
   `ops install <host> <user>@<address>`. It asks you to type the host name first.
2. Do each service's one-time setup: [cluster certificates](nixos/cynic/cluster-tls-operations.md),
   [Nomad access control](nixos/cynic/nomad-acl-operations.md), and
   [OpenBao](nixos/cynic/openbao-operations.md). Then [set up backups](nixos/backup-operations.md).
3. Apply later host changes with `ops rebuild [host]`.
4. Deploy the platform cartridges (`platform-data`, `platform-ingress`, and others) with
   `ops deploy --stage <name>`.
5. In an app repository, run `ops release`.

Put `tools/alchemy/scripts` on your `PATH` to run `ops`. The full command list, and how cartridges,
secrets, and staged releases work, is in [tools/alchemy/README.md](tools/alchemy/README.md).
[Ingress](tools/alchemy/platform/ingress/README.md) and
[static sites](nixos/atheist/static-sites-operations.md) have their own guides.

## Repository layout

| Path | Contents |
| --- | --- |
| `flake.nix` | one flake for every host, the Alchemy runner package, and a test VM image |
| `nixos/` | host configurations; `modules/` is shared; `site/` holds the placeholder installation values |
| `tools/alchemy/` | the `ops` command, the Alchemy stacks, the custom Nomad, OpenBao, PostgreSQL, and Valkey resources, the platform cartridges, and the tests |
| `docs/design/` | design notes for the host runner, staged releases, and cartridges |
| `docs/research/` | PostgreSQL research |
| `docs/status.md` | dated results from test runs |
| `testground/` | scripts for a disposable local test VM. They predate the site folder and still name the author's user and subnet |

## Development

```sh
cd tools/alchemy
bun install
bun test
bun run typecheck
bun run lint
bun run format
```

`tools/alchemy/build-runtime.sh` builds the Alchemy runtime package in a resource-limited Docker
container. It does not deploy or activate anything.

## Status

Dated results from test runs are in [docs/status.md](docs/status.md). There is no license yet.

Open work:

- Prove application stacks with a database, a worker, and a web service. Production needs routable
  private addresses and firewall rules for container-to-container traffic.
- Add health-checked traffic cutover for app updates. A single-allocation job on a fixed host port
  had about 5.7 seconds of failed HTTP probes during replacement.
- Avoid in-place changes to a selected release's Nomad job settings during a rollout; they can
  replace the running allocation.
- Add traffic splitting for A/B tests. Candidate preview, promotion, and rollback work for services
  that write no host volume.
- Prove migrations and dependency provisioning end to end. Migration tasks and dependency ordering
  exist; stateful updates and data-safe rollback are open.
- Build and publish immutable application images from the platform.
- Make the OpenBao mounts and Nomad authentication setup reproducible, and narrow the deployment
  token's policy-writing privileges.
- Test restore for host volumes and shared databases, including recovery after disk loss.
- Add shared Alchemy state, and verify a service move between nodes. The runner has a host-local lock;
  concurrent operators are untested.
- Repair the Nix test-image build so a fresh disk boots without a manual filesystem repair.
- Replace the test VM's firewall and defaults with production policy before reuse.
- Name the host folders and Nomad nodes by role. `nixos/cynic`, `nixos/atheist`, and the ingress
  cartridge's `atheist` placement are the author's names, so a new installation forks those folders.
- Move the remaining installation-specific values out of `testground/`.
