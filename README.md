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
  or roll back by changing which release is selected. Only stateless services are supported.
- **Tailscale Serve** can publish a route on your tailnet only, with no public DNS.

A **cartridge** is a versioned JSON file that lists an app's services, images, ports, volumes,
routes, secret references, and database needs. The platform turns each service into one Nomad job
and orders the jobs by their dependencies.

## What you need

- Two or more x86_64 machines that run NixOS. The shared host modules assume Proxmox-style virtual
  machines (SeaBIOS, virtio disks and network); change `nixos/modules/proxmox-vm.nix` and
  `disk-config.nix` for other hardware.
- A workstation with `bun`, `docker`, `git`, and `ssh`. Docker runs the Nix builds, so the
  workstation needs no Nix.
- SSH access to each machine, with host names set in `~/.ssh/config`.

## Configure your installation

The values that belong to one installation are in a *site folder*: the LAN and registry addresses,
the operator account and its SSH keys, the ingress machine's public address and network cards, and
the Traefik routes for static sites. `nixos/site` holds placeholder values. Host folder names and
`testground/` still hold some installation-specific names (see [Status](#status)).

1. Copy `nixos/site` to a private git repository and commit it. Edit `site.toml` and the files under `routes/`.
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
| `flake.nix` | the Alchemy runtime package, the server's configuration with the staged runner, and a test VM image |
| `nixos/` | host configurations. `flake.nix` here is what hosts build; `modules/` is shared; `site/` holds the placeholder installation values |
| `tools/alchemy/` | the `ops` command, the Alchemy stacks, the custom Nomad, OpenBao, PostgreSQL, and Valkey resources, the platform cartridges, and the tests |
| `docs/design/` | design notes for the staged runner, staged releases, and cartridges |
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
- Add traffic splitting for A/B tests. Candidate preview, promotion, and rollback work for stateless
  services only.
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
