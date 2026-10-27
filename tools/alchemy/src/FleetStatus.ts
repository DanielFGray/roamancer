/**
 * One read-only picture of the cluster: each Nomad job's health and why its waiting
 * allocations cannot be placed, and each node's measured use beside what the scheduler
 * has reserved on it. `ops dash` prints it; the fleet web UI serves the same value.
 *
 * Each section is read on its own. A section whose source fails is Unavailable with the
 * reason, so a failing node-stats read still shows the jobs.
 */
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Order from "effect/Order";
import * as S from "effect/Schema";
import { Nomad, type NomadError } from "./Nomad.ts";
import type { Evaluation, JobListItem, Node, NodeStats, PlacedAllocation } from "./Nomad.ts";

export const Health = S.Literals(["healthy", "degraded", "down", "stopped"]);
export type Health = typeof Health.Type;

export const JobStatus = S.Struct({
  name: S.String,
  type: S.String,
  health: Health,
  running: S.Number,
  starting: S.Number,
  queued: S.Number,
  // Why the scheduler cannot place the queued allocations, one entry per reason.
  blockedBy: S.Array(S.String),
  checks: S.Array(S.Struct({ service: S.String, status: S.String })),
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

export const Snapshot = S.Struct({
  takenAt: S.String,
  jobs: section(JobStatus),
  nodes: section(NodeStatus),
});
export type Snapshot = typeof Snapshot.Type;

export const snapshot = Effect.fn("FleetStatus.snapshot")(function* () {
  const nomad = yield* Nomad;
  // Both sections place allocations: on a job, and on a node.
  const allocations = yield* Effect.cached(nomad.placedAllocations());
  const [jobs, nodes] = yield* Effect.all(
    [available(readJobs(nomad, allocations)), available(readNodes(nomad, allocations))],
    { concurrency: "unbounded" },
  );
  return { takenAt: new Date().toISOString(), jobs, nodes } satisfies Snapshot;
});

/**
 * Nomad calls a job "running" while it is registered, even with no allocation placed, so
 * health comes from the allocation counts and checks instead.
 */
export const health = (job: {
  readonly status: string;
  readonly type: string;
  readonly running: number;
  readonly starting: number;
  readonly queued: number;
  readonly checks: ReadonlyArray<{ readonly status: string }>;
}): Health => {
  if (job.status === "dead") return "stopped";
  if (job.running === 0 && job.type !== "batch") return "down";
  if (job.queued > 0 || job.starting > 0) return "degraded";
  if (job.checks.some((check) => check.status !== "success")) return "degraded";
  return "healthy";
};

/** The reasons in a job's newest evaluation that failed to place allocations. */
export const blockedBy = (evaluations: ReadonlyArray<Evaluation>): ReadonlyArray<string> =>
  Arr.head(evaluations.filter((evaluation) => evaluation.FailedTGAllocs !== null)).pipe(
    Option.map((evaluation) =>
      Object.values(evaluation.FailedTGAllocs ?? {}).flatMap((failed) => [
        ...Object.entries(failed.ConstraintFiltered ?? {}).map(
          ([reason, nodes]) => `${reason} (${nodes} ${nodes === 1 ? "node" : "nodes"})`,
        ),
        ...Object.entries(failed.DimensionExhausted ?? {}).map(
          ([resource, nodes]) =>
            `${resource} exhausted (${nodes} ${nodes === 1 ? "node" : "nodes"})`,
        ),
      ]),
    ),
    Option.map((reasons) => [...new Set(reasons)]),
    Option.getOrElse(() => []),
  );

/** A node's line in the snapshot; `stats` is null when the node did not answer. */
export const nodeStatus = (
  node: Node,
  allocations: ReadonlyArray<PlacedAllocation>,
  stats: NodeStats | null,
): NodeStatus => {
  const placed = allocations.filter(
    (allocation) => allocation.NodeName === node.Name && allocation.ClientStatus === "running",
  );
  return {
    name: node.Name,
    status: node.Status,
    eligible: node.SchedulingEligibility === "eligible",
    reservedMemoryMB: {
      used: reserved(placed, (task) => task.Memory.MemoryMB),
      total: node.NodeResources.Memory.MemoryMB - node.ReservedResources.Memory.MemoryMB,
    },
    reservedCpuShares: {
      used: reserved(placed, (task) => task.Cpu.CpuShares),
      total: node.NodeResources.Cpu.CpuShares - node.ReservedResources.Cpu.CpuShares,
    },
    cpuPercent:
      stats === null || stats.CPU.length === 0
        ? null
        : 100 - stats.CPU.reduce((sum, cpu) => sum + cpu.Idle, 0) / stats.CPU.length,
    memoryBytes: stats === null ? null : { used: stats.Memory.Used, total: stats.Memory.Total },
    disks: (stats?.DiskStats ?? []).map((disk) => ({
      mount: disk.Mountpoint,
      bytes: { used: disk.Used, total: disk.Size },
    })),
  };
};

const available = <A, E>(read: Effect.Effect<ReadonlyArray<A>, E>) =>
  read.pipe(
    Effect.map((items) => ({ _tag: "Available" as const, items })),
    Effect.catch((error) =>
      Effect.succeed({
        _tag: "Unavailable" as const,
        reason: error instanceof Error ? error.message : String(error),
      }),
    ),
  );

type Allocations = Effect.Effect<ReadonlyArray<PlacedAllocation>, NomadError>;

const readJobs = Effect.fn("FleetStatus.readJobs")(function* (
  nomad: typeof Nomad.Service,
  allocations: Allocations,
) {
  const jobs = Arr.sort(
    yield* nomad.jobs(),
    Order.mapInput(Order.String, (job: JobListItem) => job.ID),
  );
  const placed = yield* allocations;
  return yield* Effect.forEach(jobs, (job) => readJob(nomad, job, placed), { concurrency: 8 });
});

const readJob = Effect.fn("FleetStatus.readJob")(function* (
  nomad: typeof Nomad.Service,
  job: JobListItem,
  allocations: ReadonlyArray<PlacedAllocation>,
) {
  const running = allocations.filter(
    (allocation) => allocation.JobID === job.ID && allocation.ClientStatus === "running",
  );
  const found = yield* Effect.forEach(running, (allocation) =>
    nomad.allocationChecks(allocation.ID),
  );
  const checks = found.flatMap((checks) =>
    Option.match(checks, {
      onNone: () => [],
      onSome: (byId) =>
        Object.values(byId).map((check) => ({ service: check.Service, status: check.Status })),
    }),
  );
  const counts = {
    running: running.length,
    starting: count(job, "Starting"),
    queued: queued(job),
  };
  return {
    name: job.ID,
    type: job.Type,
    health: health({ status: job.Status, type: job.Type, checks, ...counts }),
    ...counts,
    blockedBy: counts.queued > 0 ? blockedBy(yield* nomad.evaluations(job.ID)) : [],
    checks,
  } satisfies JobStatus;
});

const readNodes = Effect.fn("FleetStatus.readNodes")(function* (
  nomad: typeof Nomad.Service,
  allocations: Allocations,
) {
  const nodes = Arr.sort(
    yield* nomad.nodes(),
    Order.mapInput(Order.String, (node: Node) => node.Name),
  );
  const placed = yield* allocations;
  return yield* Effect.forEach(
    nodes,
    (node) =>
      (node.Status === "ready" ? Effect.option(nomad.nodeStats(node.ID)) : Effect.succeedNone).pipe(
        Effect.map((stats) => nodeStatus(node, placed, Option.getOrNull(stats))),
      ),
    { concurrency: "unbounded" },
  );
});

/** Allocations of the job that wait for a node. */
export const queued = (job: JobListItem) => count(job, "Queued");

const count = (job: JobListItem, key: string) =>
  Object.values(job.JobSummary?.Summary ?? {}).reduce((sum, group) => sum + (group[key] ?? 0), 0);

type TaskReservation = NonNullable<PlacedAllocation["AllocatedResources"]>["Tasks"][string];

const reserved = (
  allocations: ReadonlyArray<PlacedAllocation>,
  amount: (task: TaskReservation) => number,
) =>
  allocations
    .flatMap((allocation) => Object.values(allocation.AllocatedResources?.Tasks ?? {}))
    .reduce((sum, task) => sum + amount(task), 0);

/** The snapshot as text for a terminal: a line per job, then a line per node. */
export const render = (snapshot: Snapshot): string =>
  [
    `jobs`,
    ...renderSection(snapshot.jobs, (job) => {
      const counts = [
        `${job.running} running`,
        ...(job.starting > 0 ? [`${job.starting} starting`] : []),
        ...(job.queued > 0 ? [`${job.queued} queued`] : []),
      ].join(", ");
      const failing = job.checks.filter((check) => check.status !== "success");
      return [
        `  ${job.health.padEnd(8)} ${job.name.padEnd(24)} ${job.type.padEnd(7)} ${counts}`,
        ...job.blockedBy.map((reason) => `           waiting: ${reason}`),
        ...failing.map((check) => `           check ${check.service}: ${check.status}`),
      ];
    }),
    ``,
    `nodes`,
    ...renderSection(snapshot.nodes, (node) => [
      `  ${node.name.padEnd(12)} ${node.status}${node.eligible ? "" : " (ineligible)"}` +
        `  cpu ${node.cpuPercent === null ? "?" : `${Math.round(node.cpuPercent)}%`}` +
        `  mem ${node.memoryBytes === null ? "?" : usage(node.memoryBytes, gib)}` +
        `  reserved mem ${usage(node.reservedMemoryMB, (mb) => `${mb}MB`)}` +
        `  reserved cpu ${usage(node.reservedCpuShares, (mhz) => `${mhz}MHz`)}`,
      ...node.disks.map((disk) => `               disk ${disk.mount} ${usage(disk.bytes, gib)}`),
    ]),
  ].join("\n");

const renderSection = <A>(
  section:
    | { readonly _tag: "Available"; readonly items: ReadonlyArray<A> }
    | {
        readonly _tag: "Unavailable";
        readonly reason: string;
      },
  line: (item: A) => ReadonlyArray<string>,
) =>
  section._tag === "Available" ? section.items.flatMap(line) : [`  unavailable: ${section.reason}`];

const usage = (
  value: { readonly used: number; readonly total: number },
  unit: (n: number) => string,
) =>
  `${unit(value.used)}/${unit(value.total)} (${value.total === 0 ? 0 : Math.round((100 * value.used) / value.total)}%)`;

const gib = (bytes: number) => `${(bytes / 2 ** 30).toFixed(1)}G`;
