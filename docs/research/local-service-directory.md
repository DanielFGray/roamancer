# Local Service Directory: What Alchemy Actually Provides

## Scope

Research only. No runtime changes. Distinguishes what `tools/alchemy` already implements from what would need new work. This repo has no launcher and assumes Nomad is already running.

## Implemented Capabilities (source-cited)

### Declaration inventory exists in cartridge JSON

A cartridge (`tools/alchemy/src/Cartridge.ts`) is the ordered declaration inventory of Alchemy-owned resources:
- `NomadService` (Nomad job backed by Podman), `PostgresDatabase`, `ValkeyServer`, `ValkeyAccess`, `ValkeyAdminCredential`
- Schema: `tools/alchemy/src/Cartridge.ts:28-32` (`Cartridge` struct)
- Validation (duplicate names, dependency ordering): `tools/alchemy/src/Cartridge.ts:34-226` (`resourceOrderError`)
- Loader reads `ALCHEMY_CARTRIDGE` path: `tools/alchemy/src/Cartridge.ts:229-251`

This is **declaration inventory**, not a running-service directory. It says what should exist, not what is running.

### Nomad API client surface implemented

`tools/alchemy/src/Nomad.ts` wraps the Nomad HTTP API. Implemented methods:

| Method | HTTP path | Lines | Returns |
|--------|-----------|-------|---------|
| `jobs` | `GET /v1/jobs?meta=true` | 200-203 | `JobListItem[]` (ID, JobModifyIndex, Meta) |
| `job(name)` | `GET /v1/job/:name` | 204 | `Option<JobSnapshot>` |
| `service(name)` | `GET /v1/service/:name` | 229-237 | `ServiceLocation[]` (address, port, AllocID) |
| `allocation(id)` | `GET /v1/allocation/:id` | 238-243 | `Option<AllocationSnapshot>` |
| `allocationChecks(id)` | `GET /v1/allocation/:id/checks` | 244-249 | `Option<AllocationChecks>` |
| `stop(name)` | `DELETE /v1/job/:name?purge=true` | 285-288 | void |
| `plan(job, owner)` | `POST /v1/job/:name/plan?Diff=true` | 205-209 | `PlanResponse` |
| `register(job, owner, idx)` | `POST /v1/jobs` | 215-220 | `Registration` |
| `deployment(name)` | `GET /v1/job/:name/deployment` | 227-228 | `Option<Deployment>` |
| `allocationChanges` | `GET /v1/event/stream?topic=Allocation` | 250-284 | Stream of AllocIDs |

Source of truth: `tools/alchemy/src/Nomad.ts:100-291` (the `Nomad` service interface and `layer`).

Callers of `nomad.jobs()` (the only live-job inventory):
- `tools/alchemy/src/NomadJob.ts:60` — `NomadJobProvider.list`: filters jobs whose `Meta.alchemy.provider === "Nomad.Job"` and `alchemy.owner` is set; returns `{id, modifyIndex, owner}`.
- `tools/alchemy/src/ReleaseSet.ts:223` — `ReleaseSetProvider.diff`: inspects live jobs for hasUnexpectedJob.
- `tools/alchemy/src/ReleaseSet.ts:377` — `ReleaseSetProvider.reconcile`: lists live jobs to clean up owned extra jobs.
- `tools/alchemy/src/ReleaseSet.ts:425` — `ReleaseSetProvider.read`: adopts via `adoptionAttributes(olds, fqn, yield* nomad.jobs())`.

There is **no `nomad.allocationLogs` method** and no log retrieval anywhere in `tools/alchemy` or `tools/infra`.

### Operation journal covers reconcile/delete only

`tools/alchemy/src/OperationJournal.ts` is an Effect event log backed by SQLite at `.alchemy/operations.sqlite`.

Schema fields (`tools/alchemy/src/OperationJournal.ts:19-25`):
```
operationId: string
resourceId: string
provider: string   // e.g. "Nomad.Job", "Nomad.ReleaseSet", "Postgres.Database", ...
target: string     // e.g. job name, "server/database", "server/resourceName"
action: "reconcile" | "delete"   // only two actions
timestampMs: number
```

Events: `OperationStarted`, `OperationSucceeded`, `OperationFailed`, `OperationResolved` (lines 28-33).

Callers of `journal.run` (every journal write):
- `tools/alchemy/src/NomadJob.ts:122` (reconcile), `:194` (delete)
- `tools/alchemy/src/ReleaseSet.ts:305` (reconcile), `:404` (delete)
- `tools/alchemy/src/PostgresDatabase.ts:224` (reconcile), `:236` (delete)
- `tools/alchemy/src/ValkeyAccess.ts:211` (reconcile), `:222` (delete)
- `tools/alchemy/src/ValkeyAdminCredential.ts:59` (reconcile), `:71` (delete)

History reader: `tools/alchemy/src/history.ts` prints `OperationHistory.formatOperation(event)` (`OperationJournal.ts:164-171`) — timestamp, `_tag`, action, provider, target, resourceId. It does **not** record process start/stop, cwd, restart command, allocation state, logs, or any native `bun run dev` lifecycle.

What is **not** journaled:
- Native `bun run dev` process lifecycle (no start/stop/restart recording)
- Allocation start/stop or ClientStatus transitions
- Allocation log output
- Health-check pass/fail events
- Deployment version changes
- Any non-Alchemy-owned Nomad job

### What providers expose (list/diff/reconcile/delete/read)

`tools/alchemy/src/NomadJob.ts:51-244` — `NomadJobProvider`
- `list`: returns owned jobs from `nomad.jobs()` (lines 59-76)
- `diff`: checks `journal.hasPending(fqn)`, then `nomad.job(name)`, then `nomad.plan`, then `nomad.deployment` health (lines 77-108)
- `reconcile`: `journal.run` wraps `nomad.job` → `nomad.plan`/`nomad.register` → `settle` (lines 109-192)
- `delete`: `journal.run` wraps `nomad.stop` (lines 193-229)
- `read`: returns ownership attributes or `Unowned` (lines 230-241)

`tools/alchemy/src/ReleaseSet.ts:207-429` — `ReleaseSetProvider`
- `list`: `Effect.succeed([])` (line 215) — returns nothing from Nomad
- `diff`: validation + journal pending check + `nomad.jobs()` + health + route matching
- `reconcile`: `journal.run` wraps ensureRelease + Caddy routes + cleanup
- `delete`: `journal.run` wraps Caddy route deletion + `nomad.stop`

### History CLI exists but is journal-only

`bun run history` (`tools/alchemy/package.json:16`) runs `tools/alchemy/src/history.ts`, which reads `OperationJournal.history` from `.alchemy/operations.sqlite`. It shows recorded operation events only — not running services, not recently run native processes, not allocations, not logs.

### Native `bun run dev` processes: no integration exists

There is no code in `tools/alchemy` or `tools/infra` that tracks, starts, stops, or records native `bun run dev` processes. The `bun` command is used to *run Alchemy itself* (`alchemy.run.ts`, `staged.run.ts`), not to manage developer workloads as Alchemy resources. `tools/alchemy/src/Cartridge.ts` accepts only `CartridgeJob` → `image`-based Nomad jobs (`tools/alchemy/src/Job.ts:95-121`; `Driver: "podman"` at `tools/alchemy/src/Job.ts:241`). No schema field, provider, or journal event represents a native process.

## Nomad GC and History Limits (official API)

Official Nomad API documentation:
- Jobs list: https://developer.hashicorp.com/nomad/api/jobs
- Single job: https://developer.hashicorp.com/nomad/api/job
- Allocations: https://developer.hashicorp.com/nomad/api/allocations
- Allocation logs: https://developer.hashicorp.com/nomad/api/allocation-logs
- Events stream: https://developer.hashicorp.com/nomad/api/events

Relevant GC/retention behavior:
1. **Jobs disappear from `/v1/jobs` after purge.** `nomad.stop` sends `DELETE /v1/job/:name?purge=true` (`tools/alchemy/src/Nomad.ts:286`), which removes the job from the job list. There is no `jobs` history query for purged jobs.
2. **Terminal allocation retention is bounded.** Server allocation records and client allocation files have separate garbage-collection rules. This investigation did not verify the configured retention periods, so it cannot promise a recent-history window.
3. **Allocation logs are not a durable archive.** Logs can remain available after a task stops, until the client removes the allocation files. The client exposes them through `/v1/client/fs/logs`. See https://developer.hashicorp.com/nomad/api-docs/client#read-file-logs.
4. **Event replay is bounded.** The event stream accepts an index for replay from its retained buffer, not an unlimited historical query. A watcher over that stream must reconcile after every reconnect, because an index does not recover the gaps. See https://developer.hashicorp.com/nomad/api-docs/events.

So Nomad itself does **not** provide a durable "recently run" directory. It provides current job/allocation state plus short-lived event streams and terminal-allocation logs.

## Declaration Inventory vs Implemented Directory CLI

| | Declaration inventory | Running/recent directory |
|---|---|---|
| Exists | Yes — cartridge JSON (`Cartridge.ts:29-32`) | No |
| Source of "running" | Nomad job registration (`Nomad.ts:216`) | Nothing implemented |
| Source of "recent" | Operation journal reconcile/delete only (`OperationJournal.ts:19-25`) | Nothing implemented |
| CLI | `bun run plan`, `bun run deploy`, `bun run destroy`, `bun run history` | No directory command |
| Liveness | `nomad.jobs()` + `nomad.service()` + health checks | No process liveness tracking |

## What New Persistent History/Process Ownership Would Require

None of the following exists, and none is claimed to be free:

1. **Native process liveness tracking.** A `bun run dev` wrapper would need to record start/stop, cwd, restart command, and PID into a persistent store before Alchemy could show it in a directory. No lifecycle-owning component exists today.
2. **Allocation log retrieval.** Adding `nomad.allocationLogs(id)` to `Nomad.ts` (HIT `/v1/allocation/:id/logs`) would expose Nomad logs, but only for non-GC'd allocations; historical logs after GC are not recoverable from Nomad.
3. **Durable "recently run" record.** Because Nomad purges jobs and GC's terminal allocations, a separate persistent record (e.g., appending to `OperationJournal` or a new history table) would be needed to show jobs that ran but are no longer in `/v1/jobs`. Currently `OperationJournal` only records reconcile/delete, not allocation start/stop or deployment version.

## Minimum-Cost Recommendation

**Scope:** reuse existing runtimes if already running (Nomad via `NOMAD_ADDR`, Alchemy via `.alchemy/`). Do not claim any capability is free installation — Nomad, Podman, OpenBao, Caddy, and the Alchemy stack must already be present.

**Minimum wiring, using only what exists:**
1. **Show running Alchemy-owned services** by combining `nomad.jobs()` (`Nomad.ts:200-203`) with `nomad.service(name)` (`Nomad.ts:229-237`) and `nomad.allocation(allocID)` (`Nomad.ts:238-243`) to list `{name, address, port, clientStatus, desiredStatus}` for jobs whose `Meta.alchemy.provider` is set. No new provider needed — compose existing methods.
2. **Show recent Alchemy operations** by reading `OperationJournal.history` (`OperationJournal.ts:67-72`) — already exposed by `bun run history` (`tools/alchemy/package.json:16`). Clarify that this is reconcile/delete history only, not process lifecycle.

Native process tracking and durable run history need separate design work. Allocation log access can initially use the existing Nomad CLI instead of a new client method. These are recommendations, not new architecture rules.

## Conflicting Design Rules

None found. AGENTS.md states Alchemy owns application desired state on the rebuilt NixOS host, Nix owns the host/rootless Podman, Nomad schedules containers, and application properties contain secret references not values. This is consistent with the existing Alchemy/Nomad architecture. The only gap is that native `bun run dev` processes sit outside this model entirely — not a conflict, but an explicit boundary.
