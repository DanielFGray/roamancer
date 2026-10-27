# Host-owned Alchemy runner

## Problem

The workstation trial stores Alchemy state and its operation journal in one checkout. Its deploy wrapper uses a local file lock, which cannot coordinate with processes on a NixOS host. The host must own the accepted release, Alchemy state, operation journal, and every apply that holds deploy tokens.

## Current design

Nix installs the Alchemy runner on the control host (`site.cluster.server`). The package is the host program (`alchemy-runner` → `src/cli.ts`) with production dependencies and loopback defaults for Nomad and OpenBao. A system user `alchemy` owns `/var/lib/alchemy`. Credential-bearing code is only that Nix-installed runner from the last `ops rebuild` switch.

Submissions arrive on a unix socket (`/run/alchemy/submit.sock`). The socket front end writes durable queue rows; it does not run the work. Jobs run one at a time as systemd template units (`alchemy-job@<id>.service`, `User=alchemy`), so journald holds the logs. A git push carries data only (stage, cartridge, image digests): never code that runs with tokens. Platform code changes go live through `ops rebuild`.

`deploy-repos.nix` prepares the operator checkouts and advertises push options so a post-receive hook can read them and enqueue.

## What the queue adds

An earlier synthesis preferred a direct SSH runner with no broker: one process owner and a small surface. A durable queue and socket add request IDs, persistence, status, cancellation, and retention, but they keep work alive after disconnect, serialize applies globally, and keep tokens out of the operator session and out of hook scripts. The project chose the queue on 2026-10-27.

## Tradeoffs accepted

- We accept one global job at a time in exchange for simple state ownership and no per-stage parallelism.
- We accept that a crash after provider changes leaves those changes running; a job interrupted by restart becomes `interrupted`, and a plan job is queued to show drift. Nothing auto-reapplies.
- We accept that push returns after durable enqueue; `ops wait <job>` reports the result.

## Risks and limits

The SSH account and group membership for the submit socket must match the operator. Alchemy's local state and operation journal still need backup and restore. Cutover still moves Alchemy state under the runner account, removes the operator from group `alchemy`, and routes mutating ops through the socket.
