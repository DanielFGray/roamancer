# Host-owned Alchemy runner

## Problem

The workstation trial stores Alchemy state and its operation journal in one checkout. Its deploy wrapper uses a local file lock, which cannot coordinate with processes on a NixOS host. The host must own the accepted release, Alchemy state, operation journal, and every apply that holds deploy tokens.

## Current design

Nix installs the Alchemy runner on the control host (`site.cluster.server`). The package is the host program (`alchemy-runner` → `src/cli.ts`) with production dependencies and loopback defaults for Nomad and OpenBao. A system user `alchemy` owns `/var/lib/alchemy`. Credential-bearing code is only that Nix-installed runner from the last `ops rebuild` switch.

Submissions arrive on a unix socket (`/run/alchemy/submit.sock`, group `alchemy-submit`). The socket-activated front end (`alchemy-runner queue serve`) writes durable SQLite rows at `/var/lib/alchemy/queue.sqlite` (Effect SqlClient / bun sqlite driver, versioned migrations) and starts work; it does not run Alchemy itself. Jobs run one at a time as systemd template units (`alchemy-job@<id>.service`, `User=alchemy`), so journald holds the logs. A polkit rule lets `alchemy` start only those units. A git push carries data only (stage, cartridge, image digests): never code that runs with tokens. Platform code changes go live through `ops rebuild`.

Each job row is data only: a command-specific payload (`plan`/`deploy`/`destroy`/`drift`: `{stage, cartridge?, origin, revision}`; `rollback`: `{name, deploymentId}`), state, exit code, and timestamps. The runner builds Alchemy argv from host-owned paths — no free caller args reach a child process. Queued deploy/destroy/rollback always pass Alchemy `--yes`: the socket submit is the approval (the workstation shows the plan and asks before it submits). Interactive host commands take only `--stage` and optional `--yes`. The cartridge JSON on a stage row is the retained release payload. States are `queued`, `starting`, `running`, `succeeded`, `failed`, `interrupted`, and `canceled`. A submit commits the row before the caller receives the id. Duplicate submits get distinct ids.

Scheduling is an atomic SQLite reservation (`queued` → `starting` only when no row is `starting`/`running`), then `systemctl start` of that unit. The job body claims `starting` → `running` before it runs Alchemy; a cancel of a `starting` row wins that race so Alchemy never runs. Unit process state is not the exclusion lock.

Socket requests are one JSON line per connection: `submit`, `list`, `show`, `wait` (returns when the job ends), `cancel` (`queued` or `starting` only), `token` (atomic write of the minted 2h OpenBao token at `/run/alchemy/openbao.token`, mode 0600 via temp+rename; never the root token; never logged), and `next` (reserve and start the next row if idle). The listener uses BunSocketServer / Node `ListenOptions`, which accepts a unix `path` or an inherited systemd `fd`. The front end also runs `tryStart` every 30s so a missed `next` cannot stall the queue.

`alchemy-job@` runs `alchemy-runner job run %i`. On every unit exit, `ExecStopPost` runs `alchemy-runner job finished %i`: if the row is still `queued`, `starting`, or `running`, mark it `failed` (or `interrupted` when `SERVICE_RESULT` is a kill/signal/timeout), then send `next` on the submit socket (failures are not swallowed). The job body does not send `next` itself. A missing OpenBao token marks the job failed with `LoginRequired` (`run ops login`).

On front-end start, every `starting`/`running` row becomes `interrupted` and one `plan` job per distinct stage is enqueued in a single transaction. The front end never re-runs a deploy by itself.

`show` returns the unit name so the operator reads logs with `journalctl`. `wait` does not read the journal.

`deploy-repos.nix` prepares the operator checkouts and advertises push options so a post-receive hook can read them and enqueue.

## What the queue adds

An earlier synthesis preferred a direct SSH runner with no broker: one process owner and a small surface. A durable queue and socket add request IDs, persistence, status, cancellation, and retention, but they keep work alive after disconnect, serialize applies globally, and keep tokens out of the operator session and out of hook scripts. The project chose the queue on 2026-10-27.

## Tradeoffs accepted

- We accept one global job at a time in exchange for simple state ownership and no per-stage parallelism.
- We accept that a crash after provider changes leaves those changes running; a job interrupted by restart becomes `interrupted`, and a plan job is queued to show drift. Nothing auto-reapplies.
- We accept that push returns after durable enqueue; `ops wait <job>` reports the result.
- The unit reports its own end via ExecStopPost so a kill or early failure cannot stall the queue.

## Risks and limits

The SSH account and group membership for the submit socket must match the operator. Alchemy's local state and operation journal still need backup and restore. Cutover still moves Alchemy state under the runner account, removes the operator from group `alchemy`, and routes mutating ops through the socket.
