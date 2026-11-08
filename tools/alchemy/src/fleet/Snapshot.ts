/**
 * The fleet snapshot's shape: what the fleet service serves, `ops dash` prints and the
 * fleet page shows. FleetStatus.ts reads it. This module imports only Schema and the
 * queue's vocabularies, so the page can decode it in a browser.
 *
 * Each section is read on its own. A section whose source fails is Unavailable with the
 * reason, so a failing node-stats read still shows the jobs.
 */
import * as S from "effect/Schema";
import { JobCommand, JobState } from "../queue/Kinds.ts";

export const Health = S.Literals(["healthy", "degraded", "down", "stopped"]);
export type Health = typeof Health.Type;

const TaskStatus = S.Struct({
  name: S.String,
  state: S.String,
  restarts: S.Number,
  startedAt: S.NullOr(S.String),
  // The newest task event: why a task restarted, waits, or failed.
  lastEvent: S.NullOr(S.Struct({ type: S.String, message: S.String, at: S.String })),
});

/** One live allocation of a job: a container group on one node. */
export const AllocationStatus = S.Struct({
  id: S.String,
  node: S.String,
  status: S.String,
  // The job version it runs; older than the job's while a deployment rolls out.
  version: S.Number,
  createdAt: S.String,
  tasks: S.Array(TaskStatus),
});
export type AllocationStatus = typeof AllocationStatus.Type;

export const JobStatus = S.Struct({
  name: S.String,
  type: S.String,
  // Null when the job was deregistered between the list and the spec read.
  version: S.NullOr(S.Number),
  images: S.Array(S.String),
  health: Health,
  running: S.Number,
  starting: S.Number,
  queued: S.Number,
  // Why the scheduler cannot place the queued allocations, one entry per reason.
  blockedBy: S.Array(S.String),
  checks: S.Array(S.Struct({ service: S.String, status: S.String })),
  allocations: S.Array(AllocationStatus),
});
export type JobStatus = typeof JobStatus.Type;

const Usage = S.Struct({ used: S.Number, total: S.Number });

export const NodeStatus = S.Struct({
  name: S.String,
  status: S.String,
  eligible: S.Boolean,
  // Reserved by the scheduler for running allocations, against what it may hand out.
  // A job waits on these numbers, not on measured use.
  reservedMemoryMB: Usage,
  reservedCpuShares: Usage,
  // Measured by the node; null when the node did not answer.
  cpuPercent: S.NullOr(S.Number),
  memoryBytes: S.NullOr(Usage),
  disks: S.Array(S.Struct({ mount: S.String, bytes: Usage })),
});
export type NodeStatus = typeof NodeStatus.Type;

const section = <A, I>(item: S.Codec<A, I>) =>
  S.Union([
    S.TaggedStruct("Available", { items: S.Array(item) }),
    S.TaggedStruct("Unavailable", { reason: S.String }),
  ]);

export const AppRelease = S.Struct({
  name: S.String,
  deployment: S.Number,
  revision: S.String,
  deployedAt: S.String,
  // The Nomad jobs the release runs: its cartridge's service names.
  jobs: S.Array(S.String),
});
export type AppRelease = typeof AppRelease.Type;

/** One job of the Alchemy runner queue: an `ops` command on the control host. */
export const RunnerJob = S.Struct({
  id: S.Number,
  command: JobCommand,
  subject: S.NullOr(S.String),
  state: JobState,
  exitCode: S.NullOr(S.Number),
  createdAt: S.String,
  startedAt: S.NullOr(S.String),
  finishedAt: S.NullOr(S.String),
});
export type RunnerJob = typeof RunnerJob.Type;

/** A dashboard that Alchemy deployed to OpenObserve, and where it opens on the tailnet. */
export const DashboardLink = S.Struct({ name: S.String, title: S.String, url: S.String });
export type DashboardLink = typeof DashboardLink.Type;

/**
 * The dashboard whose tab shows one job's memory, CPU, restarts and failures, and the
 * variable that filters that tab (platform/observability/dashboards/nomad.json).
 */
export const jobDashboard = { name: "nomad", tab: "jobs", variable: "job" } as const;

/** The job dashboard filtered to one Nomad job; undefined while that dashboard is not deployed. */
export const jobDashboardUrl = (
  dashboards: ReadonlyArray<DashboardLink>,
  job: string,
): string | undefined => {
  const dashboard = dashboards.find((entry) => entry.name === jobDashboard.name);
  if (dashboard === undefined) return undefined;
  const url = new URL(dashboard.url);
  url.searchParams.set("tab", jobDashboard.tab);
  url.searchParams.set(`var-${jobDashboard.variable}`, job);
  return url.toString();
};

export const Snapshot = S.Struct({
  takenAt: S.String,
  jobs: section(JobStatus),
  nodes: section(NodeStatus),
  // The newest recorded release of each app that `ops release` deployed.
  apps: section(AppRelease),
  // The newest runner jobs, newest first: what is running, waiting, and what just ended.
  runner: section(RunnerJob),
  // The deployed OpenObserve dashboards; the page links each job to its view of the job dashboard.
  dashboards: section(DashboardLink),
});
export type Snapshot = typeof Snapshot.Type;
