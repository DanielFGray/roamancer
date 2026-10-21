# server-ansible

This repository is rebuilding its application deployment platform around three owners:

- **NixOS** owns the host, rootless Podman, Nomad, and host volumes.
- **Nomad** places and runs application containers.
- **Alchemy** declares and reconciles application state through Nomad.

OpenBao remains the secret store. Application declarations must contain secret references, not secret values. Existing Ansible hosts remain under `tools/infra` until the production host is rebuilt from backup on fresh NixOS. The NixOS testground is a disposable proof environment.

## Cynic host

`nixos/cynic` pins the NixOS configuration for `10.13.37.196`. Nomad and rootless Podman have passed a disposable container run and a host reboot. Nomad retains its node identity after reboot. Tailscale also returns without a new login.

The repository-root flake builds the Alchemy runtime and the host from one
pinned Nix package set. Run these commands from the
repository root on a separate builder. The runtime source must be inside the
flake source directory. Build application packages outside `cynic`.

```sh
nix build .#alchemy-staged
nix build .#nixosConfigurations.cynic.config.system.build.toplevel
```

The root configuration includes Nomad ACLs and the host-owned Alchemy
staged runner. The staged commands read their Nomad credential file at run
time. Building does not activate this configuration. Follow
`nixos/cynic/nomad-acl-operations.md` for credential setup. The nested host
flake does not include the staged runner.

For a local Docker builder, run `tools/alchemy/build-runtime.sh`. It limits the
whole build to 2 GiB RAM, no container swap, one CPU, and one Nix build at a
time. It keeps its Nix store and temporary files under
`$HOME/.cache/server-ansible-builder`, or `NIX_BUILDER_DIR` when set. The script
requires at least 2 GiB free disk before starting and stops the container if
free space falls below 1 GiB. It prints the output path
inside the builder's Nix store and does not deploy or activate anything.

Traefik is the HTTP entry point on `cynic`, and one Caddy process behind it on loopback serves every static site. Nomad application routes are tags on their Nomad services, which Traefik follows as allocations move. The host firewall allows port 80 only on `ens18`; port 443 is closed. See [Ingress on cynic](nixos/cynic/traefik-operations.md).

Production inventory puts `web01` in the `nixos` group. Every play in `site.yml` excludes that group. Its peer address remains in inventory for the existing `atheist` configuration. The disposable Ansible testground keeps its own inventory and retains its web-node plays.

Nomad control-plane listeners use loopback. Operators must use SSH to run Nomad commands or forward port 4646. Application ports still require a tested private routing and firewall policy. The host-owned Alchemy runner is configured in the root flake but is not activated on this host yet.

A disposable bridge-network web service served a file from `noneuclid-data`. After allocation replacement, the replacement served the same file through the new address and port returned by Nomad service discovery. This proves one-node storage retention and host-local HTTP access only. It does not prove container-to-container access, ingress from `atheist`, multi-node routing, or recovery after disk loss. The job and its test files were removed.

Backups are deferred with the operator's accepted data-loss risk. This is a temporary exception to the planned rebuild-from-backup workflow. No production database has been deployed on this node. OpenBao connectivity and workload secret delivery remain unverified. Public DNS is unchanged.

## Current proof

The local QEMU staging VM needs `-enable-kvm -cpu host`. The generic QEMU CPU
model caused the packaged Bun runtimes to stall or fail with an illegal
instruction. With host CPU features, both tested runtimes started and used
little CPU. The current disposable guest
has 2 GiB RAM and a 12 GiB virtual disk. Its source disk and running process
are local test artifacts, not a reproducible staging provisioner yet.

The `nixos/testground` flake builds a NixOS QCOW image. This turn built it in the existing rootless Nix store, then booted NixOS 26.11 with Nomad 2.0.7 and rootless Podman 5.8.8 using `crun`. The new image needed ext4 repair on its disposable overlay before it booted. The image build must be investigated before relying on unattended rebuilds. Nomad's Prometheus endpoint returns node and allocation metrics.

Alchemy deployed a rootless bridge-network update to the Noneuclid app on the testground VM. After a cartridge update and restoration, Nomad reports a healthy version 4 allocation, the app returns HTTP 200, and Alchemy reports no changes. Noneuclid's working tree contains a versioned JSON deployment file, and the Alchemy runner validates it before planning. See [`tools/alchemy/README.md`](tools/alchemy/README.md) for the deploy commands and current limits.

## Deployment path

1. Build and boot the NixOS testground image from [`nixos/testground`](nixos/testground).
2. Declare the app job in the project's versioned cartridge and point the Alchemy runner under [`tools/alchemy`](tools/alchemy) at that file.
3. Plan and reconcile the Nomad resources through Alchemy.
4. Keep secrets in OpenBao and host volume paths in NixOS configuration.

The cartridge currently describes one Nomad job with one task. It does not yet build or publish app images, resolve app dependency names to managed resources, deliver OpenBao secrets to workloads, or coordinate durable application state across hosts.

## Staged releases

Target behavior: deploy a candidate beside the live release at a generated preview URL. Test it on a real client, such as a phone, before changing the usual app URL. Promote a healthy candidate, retain the prior release for rollback, and preserve app data. The current proof has local `*.localhost` routes; it does not yet provide phone access or stateful release safety.

Later, support traffic splitting between two releases for A/B testing. Keep this separate from candidate preview and promotion: a preview gets test traffic by its own URL, while an A/B release shares production traffic under an explicit split policy.

`tools/alchemy` now has a stateless `Nomad.ReleaseSet` resource. A manifest declares immutable image digests, a selected release, and an optional candidate. Alchemy creates a separate Nomad job for each release, waits for Nomad's health check, publishes a candidate preview host, and routes the usual host to the selected release. Promotion and rollback change the selected release in the manifest. Each release's routes are Traefik tags on its Nomad service, so a promotion is an in-place Nomad update and a moved allocation keeps its route without an Alchemy run. See the [staged release operator flow](tools/alchemy/README.md#staged-release-proof).

The release proof used a disposable single-node NixOS VM, two digest-pinned `whoami` images, Nomad, rootless Podman, and Caddy. Both versions ran together. The preview host returned v2 while the stable host still returned v1. Promotion switched stable traffic to v2; rollback switched it to v1. Candidate cleanup removed its job and preview route, and a repeat plan reported no changes. The stable route survived a Caddy restart. A manual Caddyfile reload removed it; Alchemy detected the missing route and restored it. A Nomad allocation reschedule changed the dynamic port; the stable route returned HTTP 502 until Alchemy detected and repaired it. The VM used `localhost` hostnames and an SSH tunnel to keep Caddy's admin API on loopback; public DNS and TLS are not configured. Restoration after losing Alchemy state remains unverified. See the [staged release design](docs/design/staged-releases.md). That proof used Caddy routes written through its admin API. On 2026-10-21 cynic replaced them with Traefik tags; [Ingress on cynic](nixos/cynic/traefik-operations.md) records the new measurements.

## Current gaps

- Prove and model application stacks with a database, worker, and web service. In the probe, a rootless `pasta` client could not reach the backend through its Nomad node address and published port. Rootless Podman bridge networking plus Nomad's native service template did allow it. This path uses a node address and published port; production must define routable private addresses and firewall rules.
- Add health-checked traffic cutover for app updates. The current single-allocation job on a fixed host port had about 5.7 seconds of failed HTTP probes during replacement.
- Avoid in-place updates to a selected release's Nomad job settings during rollout; those changes can replace the running allocation and interrupt traffic.
- Add controlled traffic splitting for A/B tests. Candidate preview, promotion, and rollback are implemented for stateless services only.
- Add lifecycle handling for migrations, dependency readiness, stateful updates, and image rollback.
- Build and publish immutable application images.
- Resolve narrowly scoped OpenBao references at workload start without storing secret values in Alchemy state.
- Define backups and restore for host volumes before deploying production databases.
- Add TLS for public domains to Traefik, durable/shared Alchemy state and operation locking, and a verified service move between nodes. The current provider cannot discover or adopt release sets after Alchemy state is lost.
- Repair the Nix image build so a fresh disk boots without a manual filesystem repair.
- Replace testground firewall and VM defaults with production NixOS policy before reuse.

Use [`docs/research`](docs/research) for current PostgreSQL research. [`docs/hardening`](docs/hardening) tracks `tools/infra` control-plane work for the current hosts; it does not define application deployment on NixOS.
