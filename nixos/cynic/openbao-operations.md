# OpenBao operations on cynic

## What this covers

OpenBao runs on cynic as `services.openbao` (`nixos/cynic/openbao.nix`). It unseals
itself at start with a static seal key, which cynic keeps as a systemd credential
encrypted with the VM's TPM. This document covers the steps a person runs: the first
initialization, creating and restoring the seal key, and where the keys go.

The seal protects copies of the disk: a qcow2 file or snapshot without the VM's TPM state
cannot be opened. It does not protect a running cynic. Anyone with root there can read
secrets once OpenBao is unsealed, so limiting who has root is the guard against misuse.

Initialization runs from the operator's workstation; the seal key is created on cynic in
memory and stored only TPM-encrypted. The recovery keys, the root token and the plaintext
seal key never reach cynic's disk.

## Where the secrets live

| Secret | Stored in | Never stored in |
| --- | --- | --- |
| Seal key (32 bytes, base64, key id `cynic-1`) | password manager; on cynic only as the TPM-encrypted `/var/lib/openbao-seal/seal-key.cred` | the repo, cynic's disk in plaintext, shell history, agent transcripts |
| Recovery keys (5 shares, threshold 3) | password manager, one entry | the repo, cynic's disk, shell history |
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

`bao status` reports `Initialized: false` before the first init, and `Seal Type: static`
with `Sealed: false` after each start.

## Seal key

Create it once, before OpenBao first starts with the static seal. Run it in your own
terminal, not through an agent: it shows the key once.

```sh
ssh -t cynic.dlab sudo openbao-seal-key
```

After a rebuild from backup the VM has a new TPM, so the old credential cannot be
decrypted. Restore the saved key instead:

```sh
ssh -t cynic.dlab sudo openbao-seal-key --restore
```

Then restart OpenBao: `ssh -t cynic.dlab sudo systemctl restart openbao`. It unseals itself, and
Nomad starts its jobs once `openbao-unsealed.service` sees it unsealed.

## First initialization (once, on a new store)

Create the seal key first. Then:

```sh
bao operator init -recovery-shares=5 -recovery-threshold=3
```

Save the five recovery keys and the root token to the password manager, in the same
step. Then confirm `bao status` shows `Initialized: true` and `Sealed: false`.

## Migrate from Shamir unseal keys (once)

A store initialized with unseal keys moves to the static seal once. After the seal key
exists and the new configuration is switched in, restart OpenBao and enter three of the
old unseal keys with `-migrate`:

```sh
ssh -t cynic.dlab sudo systemctl restart openbao
bao operator unseal -migrate   # three times, a different key each time
```

`bao status` then shows `Seal Type: static` and `Sealed: false`. The old unseal keys are
now recovery keys.

## Root token

Use the root token only to create the platform's policies and JWT roles, as the
PostgreSQL proof did. Then revoke it:

```sh
bao token revoke -self
```

Keep the root token in the password manager after revocation only if you still
need a recovery path. Generate new tokens for each job and service from OpenBao.

## Recovery

- Recovery keys authorize operations such as generating a root token. They cannot
  decrypt the store: only the seal key can.
- Lost the TPM state (VM rebuilt or restored without it): restore the seal key with
  `--restore`, as above.
- Lost the seal key in the password manager and the TPM credential: the store
  cannot be unsealed. Restore from backup. Backups
  are deferred (see the README), so this is a real data-loss path. Do not
  re-initialize over an existing store.
- OpenBao refuses `bao operator init` on a store that is already initialized. Use
  `bao status` to check state. Do not try init to see whether it works.
