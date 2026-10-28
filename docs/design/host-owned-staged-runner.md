# Host-owned Alchemy runner

## Problem

The workstation trial stores Alchemy state and its operation journal in one checkout. Its deploy wrapper uses a local file lock, which cannot coordinate with processes on a NixOS host. The host must own the accepted release, Alchemy state, operation journal, and every apply that holds deploy tokens.

## Current design

Nix installs the Alchemy runner on the control host (`site.cluster.server`). The package is the host program (`alchemy-runner` → `src/cli.ts`) with production dependencies and loopback defaults for Nomad and OpenBao. The wrapper sets `ALCHEMY_RUNNER_REVISION` to the `server-ansible` commit the package was built from; `alchemy-runner version` prints that commit. A system user `alchemy` owns `/var/lib/alchemy`. Credential-bearing code is only that Nix-installed runner from the last `ops rebuild` switch. Rebuild switches the host flake with `git+file:$HOME/server-ansible` and overrides the site input. An overridden input makes Nix hide `self.rev`, so rebuild also overrides the `build` input with a folder whose `rev` file holds the checkout's commit; the committed `nixos/build/rev` is empty, which gives no revision.

Submissions arrive on a unix socket (`/run/alchemy/submit.sock`, group `alchemy-submit`). The front end (`alchemy-runner queue serve`, a long-running service that binds the socket path itself) writes durable SQLite rows at `/var/lib/alchemy/queue.sqlite` (Effect SqlClient / bun sqlite driver, versioned migrations) and starts work; it does not run Alchemy itself. Jobs run one at a time as systemd template units (`alchemy-job@<id>.service`, `User=alchemy`), so journald holds the logs. A polkit rule lets `alchemy` start only those units. A git push carries data only (stage, cartridge, image digests): never code that runs with tokens. Platform code changes go live through `ops rebuild`.

Each job row is data only: a command-specific payload (`plan`/`destroy`/`drift`: `{stage, cartridge?, origin, revision, stagedImage?}`; `deploy`: the same plus required `planJobId`; `rollback`: `{name, deploymentId}`; the stageless jobs `state` (`{verb: list, path?}` or `{verb: read, path}`), `deployment`, `status` (`{name}`), `stage-image` (`{name, stable, expect?}`), `place-queued` and `dash` (`{}`)), state, exit code, the runner revision that ran it, and timestamps. The runner builds Alchemy argv from host-owned paths — no free caller args reach a child process. Queued deploy/destroy/rollback always pass Alchemy `--yes`: the socket submit is the approval (the workstation shows the plan and asks before it submits). Stageless jobs are jobs because only the runner user can read Alchemy state, the deployment record and the controller Nomad token; taking turns with deploys means a read never sees a deploy half done. The operator runs only `submit`, `wait`, `version`, `login` and `logs` directly; `logs` reads Nomad with the read-only token in `/var/lib/nomad-acl/operator.env`. The cartridge JSON on a stage row is the retained release payload. States are `queued`, `starting`, `running`, `succeeded`, `failed`, `interrupted`, and `canceled`. A submit commits the row before the caller receives the id. Duplicate submits get distinct ids.

A `deploy` job starts only when `planJobId` names a succeeded `plan` of the same stage, cartridge, staged image, origin and revision, run by the same runner revision, with no `deploy`, `destroy` or `rollback` finished after that plan (stageless jobs, plans and drift checks change nothing). Otherwise the runner fails the deploy without running Alchemy: "the plan in job \<id\> is stale (\<reason\>): run the plan again". destroy and rollback are unchanged.

Scheduling is an atomic SQLite reservation (`queued` → `starting` only when no row is `starting`/`running`), then `systemctl start` of that unit. The job body claims `starting` → `running` (and records `ALCHEMY_RUNNER_REVISION`) before it runs Alchemy; a cancel of a `starting` row wins that race so Alchemy never runs. Unit process state is not the exclusion lock.

Socket requests are one JSON line per connection: `submit`, `list`, `show`, `wait` (returns when the job ends), `cancel` (`queued` or `starting` only), `token` (atomic write of the minted 2h OpenBao token at `/run/alchemy/openbao.token`, mode 0600 via temp+rename; never the root token; never logged), and `next` (reserve and start the next row if idle). The listener uses BunSocketServer on the unix `path`. It removes a leftover socket file before it binds. It does not use systemd socket activation, because Bun reports an inherited unix socket's address as `{}` and Effect's socket server fails on that address. The front end also runs `tryStart` every 30s so a missed `next` cannot stall the queue.

`alchemy-runner submit` reads one submit request JSON line from stdin, queues it, and prints the job id on stdout. `alchemy-runner wait <id>` streams the unit's own output (`journalctl _SYSTEMD_UNIT=<unit> -o json -f -n all`, printing each MESSAGE) to stdout until the socket `wait` returns, then prints the entries after the last cursor it printed, so no line is lost when the follower stops, and exits with the job's exit code (1 when a failed/interrupted/canceled job has none). On SIGINT it sends `cancel` from an interrupt finalizer; a refused cancel (job running) prints that the job keeps running and the journalctl command to follow it. The operator reads the journal as a wheel member. The workstation's `ops` makes one ssh call for each: it needs the plan's id to submit the deploy that names it, and it asks between the two. `ops` requests a terminal for `wait` when it has one, so ssh forwards Ctrl-C; a `wait` whose output `ops` reads has no terminal, and Ctrl-C there drops the connection and leaves the job queued.

The runner's code, the entrypoints `alchemy.run.ts` and `state.run.ts`, the platform cartridges and Alchemy itself resolve from the package in the Nix store (`src/Package.ts`), and a job runs Alchemy's CLI from there with the runner's Bun. A job's working directory is `/var/lib/alchemy`, so `.alchemy` there holds Alchemy state and the deployment record. Before the first job of a run, `ops` compares the runner's revision (`alchemy-runner version`) with its own `tools/alchemy`, uncommitted changes included, and refuses on a difference: the requests and cartridges it sends are read by that runner.

`alchemy-runner login` mints the 2h token from the root token (prompt or stdin) and sends it with the socket `token` request; it writes nothing under the operator. Each plan and deploy job checks the cartridge's secrets with the job's token, so the host has no separate secret command. Tokens never appear in job rows, argv, or logs. A job without a valid token fails fast with "run ops login".

`alchemy-job@` runs `alchemy-runner job run %i`. On every unit exit, `ExecStopPost` runs `alchemy-runner job finished %i`: if the row is still `queued`, `starting`, or `running`, mark it `failed` (or `interrupted` when `SERVICE_RESULT` is a kill/signal/timeout), then send `next` on the submit socket (failures are not swallowed). The job body does not send `next` itself.

On front-end start, every `starting`/`running` row becomes `interrupted` and one `plan` job per distinct stage of an interrupted stage-changing job is enqueued in a single transaction. A stageless job queues no plan. The front end never re-runs a deploy by itself.

`show`/`list` return the runner revision that ran each job. `show` also returns the unit name so the operator can read logs with `journalctl`. `wait` does not read the journal; `submit` does.

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
