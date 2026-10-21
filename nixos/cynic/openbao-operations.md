# OpenBao operations on cynic

## What this covers

OpenBao runs on cynic as `services.openbao` (`nixos/cynic/openbao.nix`). It starts
sealed. A sealed OpenBao cannot read or write secrets. This document covers the
steps a person runs: the first initialization, the unseal after each boot, and
where the keys go.

Initialization and unseal run from the operator's workstation, not from cynic.
The unseal keys and the root token never reach cynic's disk. This is the decision
"B" recorded for cynic. It supersedes the automatic `infra vault-init` design in
`ts-f9d862` for this host.

## Where the secrets live

| Secret | Stored in | Never stored in |
| --- | --- | --- |
| Unseal keys (5 shares, threshold 3) | password manager, one entry | the repo, cynic's disk, shell history |
| Root token | password manager, until the platform roles exist; then revoke | the repo, cynic's disk |
| Nomad and job tokens | OpenBao itself | the repo, Alchemy state |

Write the init output to the password manager directly. Do not redirect it to a
file. A file on the workstation is still a copy of the keys.

## Connect

Open a tunnel from the workstation. OpenBao listens only on cynic's loopback.

```sh
ssh -N -L 8200:127.0.0.1:8200 cynic.dlab
```

In a second shell, point the CLI at the tunnel:

```sh
export BAO_ADDR=http://127.0.0.1:8200
bao status
```

`bao status` reports `Initialized: false` before the first init, and `Sealed: true`
after each start.

## First initialization (once)

```sh
bao operator init -key-shares=5 -key-threshold=3
```

Save the five unseal keys and the root token to the password manager, in the same
step. Then confirm `bao status` shows `Initialized: true` and `Sealed: true`.

## Unseal after a start

Run after every reboot or service restart. Three different keys are required.

```sh
bao operator unseal   # paste key 1
bao operator unseal   # paste key 2
bao operator unseal   # paste key 3
```

Confirm `Sealed: false`. Until then, Nomad jobs that read OpenBao secrets fail to
start, and the platform jobs stay down.

## Root token

Use the root token only to create the platform's policies and JWT roles, as the
PostgreSQL proof did. Then revoke it:

```sh
bao token revoke -self
```

Keep the root token in the password manager after revocation only if you still
need a recovery path. Generate new tokens for each job and service from OpenBao.

## Recovery

- Lost one unseal key: the other four still unseal the store, if the threshold of
  three is met.
- Lost too many keys: the store cannot be unsealed. Restore from backup. Backups
  are deferred (see the README), so this is a real data-loss path. Do not
  re-initialize over an existing store.
- OpenBao refuses `bao operator init` on a store that is already initialized. Use
  `bao status` to check state. Do not try init to see whether it works.
