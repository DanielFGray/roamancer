# Recorded results

What has been run and observed so far, newest facts first where dates conflict. Each entry is a
result on the author's own machines on the date given, not a guarantee for another installation.
Host names (`cynic`, `atheist`) are this installation's names for its Nomad server and its
public ingress machine. The list of open work is in the [README](../README.md#status).

## Cynic

The Nomad server's NixOS configuration (`nixos/cynic`) was tested: Nomad and rootless Podman have passed a disposable container run and a host reboot. Nomad retains its node identity after reboot. Tailscale also returns without a new login.

Nomad control-plane listeners use loopback. Operators must use SSH to run Nomad commands or forward port 4646. Application ports still require a tested private routing and firewall policy. The host-owned Alchemy runner is configured in the root flake but is not activated on this host yet.

A disposable bridge-network web service served a file from `noneuclid-data`. After allocation replacement, the replacement served the same file through the new address and port returned by Nomad service discovery. This proves one-node storage retention and host-local HTTP access only. It does not prove container-to-container access, ingress from `atheist`, multi-node routing, or recovery after disk loss. The job and its test files were removed.

On 2026-10-21, Alchemy deployed shared PostgreSQL 17.6 and Valkey 8.1.3 on cynic. Their admin credentials came from OpenBao through Nomad workload identity. Authentication and container replacement checks passed; an app database and app-scoped Valkey access were not part of that proof. Public DNS was unchanged.

Secret delivery through task environment variables works in that proof. A later live probe on 2026-10-22 verified secret-file visibility after replacing Nomad's `BindReadOnlyPaths` with a host-visible `/sbin/ip` symlink. A bridge-network rootless Podman task read a dummy template from a host-visible tmpfs mount with swap disabled. See `testground/probe-nomad-secrets.sh`; restrictive file permissions require ownership that matches the rootless container's host user. This checks file delivery, not OpenBao login.

## Recorded testground proofs

The local QEMU staging VM needs `-enable-kvm -cpu host`. The generic QEMU CPU
model caused the packaged Bun runtimes to stall or fail with an illegal
instruction. With host CPU features, both tested runtimes started and used
little CPU. The recorded disposable guest
had 2 GiB RAM and a 12 GiB virtual disk. Those local artifacts do not establish
that a guest is running now or provide a reproducible staging provisioner.

The `nixos/testground` flake builds a NixOS QCOW image. The initial proof built it in the existing rootless Nix store, then booted NixOS 26.11 with Nomad 2.0.7 and rootless Podman 5.8.8 using `crun`. The new image needed ext4 repair on its disposable overlay before it booted. The image build must be investigated before relying on unattended rebuilds. Nomad's Prometheus endpoint returns node and allocation metrics.

Alchemy deployed a rootless bridge-network update to the Noneuclid app on the testground VM. After a cartridge update and restoration, the proof recorded a healthy version 4 allocation, HTTP 200, and a no-change Alchemy plan. Noneuclid's working tree contains a versioned JSON deployment file, and the Alchemy runner validates it before planning. See [`tools/alchemy/README.md`](../tools/alchemy/README.md) for the deploy commands and current limits.

## Staged releases

Target behavior: deploy a candidate beside the live release at a generated preview URL. Test it on a real client, such as a phone, before changing the usual app URL. Promote a healthy candidate, retain the prior release for rollback, and preserve app data. The current proof has local `*.localhost` routes; it does not yet provide phone access or stateful release safety.

Later, support traffic splitting between two releases for A/B testing. Keep this separate from candidate preview and promotion: a preview gets test traffic by its own URL, while an A/B release shares production traffic under an explicit split policy.

Staged releases use a staged copy of the whole cartridge (`tools/alchemy/src/StagedCartridge.ts`). `ops stage` deploys the candidate image beside the live release under suffixed names, with tailnet-only routes; `ops promote` releases that image, and `ops discard` removes the copy. Routes are Traefik tags on each Nomad service, so a moved allocation keeps its route without an Alchemy run. The proof below used an earlier `Nomad.ReleaseSet` resource, which the staged copy replaced and which has been deleted.

The release proof used a disposable single-node NixOS VM, two digest-pinned `whoami` images, Nomad, rootless Podman, and Caddy. Both versions ran together. The preview host returned v2 while the stable host still returned v1. Promotion switched stable traffic to v2; rollback switched it to v1. Candidate cleanup removed its job and preview route, and a repeat plan reported no changes. The stable route survived a Caddy restart. A manual Caddyfile reload removed it; Alchemy detected the missing route and restored it. A Nomad allocation reschedule changed the dynamic port; the stable route returned HTTP 502 until Alchemy detected and repaired it. The VM used `localhost` hostnames and an SSH tunnel to keep Caddy's admin API on loopback; public DNS and TLS are not configured. A later disposable-VM proof on 2026-10-20 adopted the existing release jobs after local Alchemy state was removed and ended with a no-change plan. That adoption proof used the earlier Caddy routing implementation. See the [staged release design](design/staged-releases.md). On 2026-10-21 cynic replaced them with Traefik tags; [Ingress](../tools/alchemy/platform/ingress/README.md) records the new measurements.

