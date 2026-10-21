# Host-owned staged runner

## Problem

The workstation trial stores Alchemy state and its operation journal in one checkout. Its controller and deploy wrapper use a local file lock, which cannot coordinate with processes on a NixOS host. The host must own the controller, accepted release manifest, Alchemy state, operation journal, and every staged apply.

## Usage

Operators send manifest bytes over the host's existing SSH connection. The host command stores a private snapshot before it applies the manifest:

```sh
cat releases/candidate.json | ssh deploy@host sudo -n -u alchemy -- alchemy-staged plan
cat releases/candidate.json | ssh deploy@host sudo -n -u alchemy -- alchemy-staged deploy --yes
```

The host stores state below `/var/lib/alchemy/.alchemy`. A systemd service starts the controller. The controller asks the same host command to reconcile allocation changes and reconnects.

## Shape

`staged-host-runner.sh` is the only writer entry point. It snapshots an input manifest, takes the state-directory lock, and calls the immutable Alchemy package. A successful deploy atomically replaces `staged-active.json` with the exact snapshot that was applied. A failed deploy keeps the prior accepted manifest and attempts to reconcile it before returning the original failure. `plan`, `deploy`, `destroy`, and controller reconciliation all take the same lock.

The systemd service owns controller lifetime. Its fixed service account owns the persistent Alchemy directory. Nix owns the Bun runtime, locked dependencies, Alchemy CLI, stack source, and controller source. Alchemy continues to own the application desired state; Nomad and Caddy remain the managed providers.

The interface has one transport rule: pass a manifest on standard input. It hides host paths, working directories, dependency versions, and lock sequencing. SSH supplies the caller identity. The first version is synchronous; an SSH disconnect interrupts the request, and the next controller reconciliation uses the last accepted manifest.

## Synthesis decision

The direct SSH runner is the base design. It retains one process owner and makes the existing apply sequence available on the host. A persistent queue and socket broker could continue work after an SSH disconnect, but that adds request IDs, queue persistence, status, cancellation, and retention before the project needs asynchronous submissions.

## Tradeoffs accepted

- We accept synchronous SSH requests in exchange for a small command surface and no new network protocol.
- We accept one host as the Alchemy writer in exchange for simple state ownership and serialization.
- We accept that a crash after provider changes but before manifest acceptance restores the previous accepted intent on restart.

## Alternatives considered

A durable deployment broker hides disconnect handling and request history behind a client command. It adds a queue database and a new protocol, which are not needed to prove host ownership. Independent workstation deploy commands expose checkout paths and cannot share the host lock.

## Risks and limits

The SSH account and sudo policy must be configured for the production operator. The controller can repair routes after allocation movement, but that repair may include an interruption while Nomad creates a replacement. Alchemy's local state and operation journal still need backup and restore. This slice does not add multi-node placement, public preview TLS, or durable asynchronous request status.

## Next implementation step

Package Alchemy and its Bun dependency closure with Nix, install the shared runner and controller as a NixOS service, then prove apply locking and recovery on the disposable VM.
