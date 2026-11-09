/**
 * One read-only picture of the cluster: each Nomad job's health, its live containers and
 * why its waiting allocations cannot be placed; each node's measured use beside what the
 * scheduler has reserved on it; each app's newest release; the newest runner jobs; and, from
 * Alchemy's state, where each deployed job answers and each OpenObserve dashboard opens.
 * The fleet service (fleet/Server.ts) serves it; `ops dash` and the fleet page read it there.
 */
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Order from "effect/Order";
import * as S from "effect/Schema";
import { State } from "alchemy/State";
import * as DeployedStages from "./DeployedStages.ts";
import { type Deployment, Deployments } from "./Deployments.ts";
import { Nomad, type NomadError } from "./Nomad.ts";
import type {
  Evaluation,
  JobListItem,
  JobSnapshot,
  Node,
  NodeStats,
  PlacedAllocation,
} from "./Nomad.ts";
import type {
  AllocationStatus,
  AppRelease,
  Health,
  JobStatus,
  NodeStatus,
  ReconcileOutcome,
  RunnerJob,
  Snapshot,
} from "./fleet/Snapshot.ts";
import { type Job, subject } from "./queue/Schema.ts";
import { type Reconcile, Store } from "./queue/Store.ts";

const runnerJobs = 20;

export const snapshot = Effect.fn("FleetStatus.snapshot")(function* () {
  const nomad = yield* Nomad;
  // Both sections place allocations: on a job, and on a node.
  const allocations = yield* Effect.cached(nomad.placedAllocations());
  const deployments = yield* Deployments;
  const store = yield* Store;
  const state = yield* yield* State;
  // Both sections read the stages: where jobs answer, and where dashboards open.
  const stages = yield* Effect.cached(DeployedStages.readStages(state));
  const [jobs, nodes, apps, runner, reconciles, dashboards, endpoints] = yield* Effect.all(
    [
      available(readJobs(nomad, allocations)),
      available(readNodes(nomad, allocations)),
      available(deployments.newest().pipe(Effect.flatMap(Effect.forEach(appRelease)))),
      available(store.list({ limit: runnerJobs }).pipe(Effect.map(Arr.map(runnerJob)))),
      available(store.listReconciles().pipe(Effect.map(Arr.map(reconcileOutcome)))),
      available(Effect.flatMap(stages, DeployedStages.dashboards)),
      available(Effect.flatMap(stages, DeployedStages.endpoints)),
    ],
    { concurrency: "unbounded" },
  );
  return {
    takenAt: new Date().toISOString(),
    jobs,
    nodes,
    apps,
    runner,
    reconciles,
    dashboards,
    endpoints,
  } satisfies Snapshot;
});

/** An app's reconcile record as the snapshot shows it. */
export const reconcileOutcome = (row: Reconcile): ReconcileOutcome => ({
  app: row.app,
  status: row.status,
  detail: row.detail,
  checkedAt: row.checkedAt,
});

/** A runner job as the snapshot shows it; the payload is reduced to what it acts on. */
export const runnerJob = (job: Job): RunnerJob => ({
  id: job.id,
  command: job.submit.command,
  subject: subject(job.submit),
  state: job.state,
  exitCode: job.exitCode,
  createdAt: job.createdAt,
  startedAt: job.startedAt,
  finishedAt: job.finishedAt,
});

/** A live allocation as the snapshot shows it, its tasks in name order. */
export const allocationStatus = (allocation: PlacedAllocation): AllocationStatus => ({
  id: allocation.ID,
  node: allocation.NodeName,
  status: allocation.ClientStatus,
  version: allocation.JobVersion,
  createdAt: fromNanos(allocation.CreateTime),
  tasks: Arr.sort(
    Object.entries(allocation.TaskStates ?? {}),
    Order.mapInput(Order.String, ([name]: readonly [string, unknown]) => name),
  ).map(([name, task]) => ({
    name,
    state: task.State,
    restarts: task.Restarts,
    startedAt: task.StartedAt ?? null,
    lastEvent: Arr.last(task.Events ?? []).pipe(
      Option.map((event) => ({
        type: event.Type,
        message: event.DisplayMessage,
        at: fromNanos(event.Time),
      })),
      Option.getOrNull,
    ),
  })),
});

const fromNanos = (nanos: number) => new Date(nanos / 1e6).toISOString();

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

// Only the service names; the record holds the whole cartridge as JSON.
const RecordedServices = S.fromJsonString(
  S.Struct({ services: S.Array(S.Struct({ name: S.String })) }),
);

const appRelease = (deployment: Deployment) =>
  S.decodeUnknownEffect(RecordedServices)(deployment.cartridge).pipe(
    Effect.map((cartridge): AppRelease => ({
      name: deployment.name,
      deployment: deployment.id,
      revision: deployment.revision,
      deployedAt: deployment.deployedAt,
      jobs: cartridge.services.map((service) => service.name),
    })),
  );

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
  const live = allocations.filter(
    (allocation) =>
      allocation.JobID === job.ID &&
      (allocation.ClientStatus === "running" || allocation.ClientStatus === "pending"),
  );
  const running = live.filter((allocation) => allocation.ClientStatus === "running");
  const [found, spec] = yield* Effect.all([
    Effect.forEach(running, (allocation) => nomad.allocationChecks(allocation.ID)),
    nomad.job(job.ID),
  ]);
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
    version: Option.match(spec, { onNone: () => null, onSome: (spec) => spec.Version }),
    images: Option.match(spec, { onNone: () => [], onSome: images }),
    health: health({ status: job.Status, type: job.Type, checks, ...counts }),
    ...counts,
    blockedBy: counts.queued > 0 ? blockedBy(yield* nomad.evaluations(job.ID)) : [],
    checks,
    allocations: live.map(allocationStatus),
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

/** The distinct images a job's tasks run, in task order. */
const images = (spec: JobSnapshot): ReadonlyArray<string> => [
  ...new Set(
    spec.TaskGroups.flatMap((group) => group.Tasks.flatMap((task) => task.Config.image ?? [])),
  ),
];

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
      const version = job.version === null ? "" : `  v${job.version}`;
      return [
        `  ${job.health.padEnd(8)} ${job.name.padEnd(24)} ${job.type.padEnd(7)} ${counts}${version}  ${job.images.join(" ")}`,
        ...job.blockedBy.map((reason) => `           waiting: ${reason}`),
        ...failing.map((check) => `           check ${check.service}: ${check.status}`),
        ...job.allocations.flatMap((allocation) =>
          allocation.tasks.map(
            (task) =>
              `           ${allocation.id.slice(0, 8)} ${allocation.node.padEnd(10)} v${allocation.version} ${task.name} ${task.state}` +
              ` since ${minute(task.startedAt ?? allocation.createdAt)}` +
              (task.restarts > 0 ? `  ${task.restarts} restarts` : "") +
              (task.lastEvent === null
                ? ""
                : `  last: ${task.lastEvent.message || task.lastEvent.type}`),
          ),
        ),
      ];
    }),
    ``,
    `runner`,
    ...renderSection(snapshot.runner, (job) => [
      `  #${String(job.id).padEnd(5)} ${job.state.padEnd(11)} ${job.command.padEnd(14)} ${(job.subject ?? "").padEnd(24)} ${minute(job.createdAt)}` +
        (job.exitCode === null || job.exitCode === 0 ? "" : `  exit ${job.exitCode}`),
    ]),
    ``,
    `reconcile`,
    ...renderSection(snapshot.reconciles, (outcome) => [
      `  ${outcome.app.padEnd(24)} ${outcome.status.padEnd(16)} ${minute(outcome.checkedAt)}  ${outcome.detail}`,
    ]),
    ``,
    `apps`,
    ...renderSection(snapshot.apps, (app) => [
      `  ${app.name.padEnd(24)} #${app.deployment} ${app.revision.slice(0, 8)} ${minute(app.deployedAt)}  ${app.jobs.join(", ")}`,
    ]),
    ``,
    `addresses`,
    ...renderSection(snapshot.endpoints, (endpoint) => [
      `  ${endpoint.job.padEnd(24)} ${endpoint.access.padEnd(7)} ${endpoint.url}`,
    ]),
    ``,
    `dashboards`,
    ...renderSection(snapshot.dashboards, (dashboard) => [
      `  ${dashboard.title.padEnd(24)} ${dashboard.url}`,
    ]),
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

// An ISO time to the minute, UTC: "2026-11-07 14:03".
const minute = (iso: string) => iso.slice(0, 16).replace("T", " ");
