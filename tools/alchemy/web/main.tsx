/**
 * The fleet page: the snapshot the fleet service serves, read again every few seconds.
 *
 * Rows are keyed by name, so a new snapshot updates each row in place. Components read
 * `props` inside JSX and never copy a prop into a local, because Solid's compiler makes
 * each prop a getter and a copy stops following it.
 */
import { type JSX, render } from "@solidjs/web";
import { Effect, Schedule } from "effect";
import { FetchHttpClient } from "effect/http";
import { HttpApiClient } from "effect/http-api";
import { type Accessor, createSignal, For, Show } from "solid-js";
import { FleetApi } from "../src/fleet/Api.ts";
import type {
  AllocationStatus,
  AppRelease,
  JobStatus,
  NodeStatus,
  RunnerJob,
  Snapshot,
} from "../src/fleet/Snapshot.ts";

// The fleet service keeps one snapshot for five seconds, so reading more often gains nothing.
const pollEvery = "5 seconds";

const [snapshot, setSnapshot] = createSignal<Snapshot | null>(null);
const [failure, setFailure] = createSignal<string | null>(null);

const poll = Effect.gen(function* () {
  const client = yield* HttpApiClient.make(FleetApi, { baseUrl: location.origin });
  yield* client.fleet.snapshot().pipe(
    Effect.match({
      onSuccess: (taken) => {
        setSnapshot(taken);
        setFailure(null);
      },
      onFailure: (error) => setFailure(error.message),
    }),
    Effect.repeat(Schedule.spaced(pollEvery)),
  );
}).pipe(Effect.provide(FetchHttpClient.layer));

const App = () => (
  <main>
    <header>
      <h1>Fleet</h1>
      <span class="muted">
        {snapshot() === null ? "loading" : `as of ${clock(snapshot()!.takenAt)}`}
      </span>
      <Show when={failure()}>
        {(message) => <span class="bad">cannot reach the fleet service: {message()}</span>}
      </Show>
    </header>
    <Show when={snapshot()}>
      {(taken) => (
        <>
          <Summary snapshot={taken()} />
          <Section title="Nodes" section={taken().nodes} key={(node) => node.name} grid>
            {(node) => <NodeCard node={node()} />}
          </Section>
          <Section title="Jobs" section={taken().jobs} key={(job) => job.name}>
            {(job) => <JobRow job={job()} />}
          </Section>
          <Section title="Runner jobs" section={taken().runner} key={(job) => job.id}>
            {(job) => <RunnerRow job={job()} />}
          </Section>
          <Section title="App releases" section={taken().apps} key={(app) => app.name}>
            {(app) => <AppRow app={app()} />}
          </Section>
        </>
      )}
    </Show>
  </main>
);

/** Counts that say at a glance whether anything needs a look. */
const Summary = (props: { snapshot: Snapshot }) => {
  const jobs = () => available(props.snapshot.jobs);
  const health = (state: JobStatus["health"]) =>
    jobs().filter((job) => job.health === state).length;
  const active = () =>
    available(props.snapshot.runner).filter((job) => !finished.has(job.state)).length;
  return (
    <section class="summary">
      <Stat label="healthy" value={health("healthy")} tone="good" />
      <Stat label="degraded" value={health("degraded")} tone="warn" />
      <Stat label="down" value={health("down")} tone="bad" />
      <Stat
        label="restarts"
        value={jobs().reduce((sum, job) => sum + restarts(job), 0)}
        tone="warn"
      />
      <Stat label="runner jobs active" value={active()} tone="warn" />
    </section>
  );
};

/** A count, coloured only when it is above zero. */
const Stat = (props: { label: string; value: number; tone: string }) => (
  <div class={`stat ${props.value > 0 ? props.tone : "muted"}`}>
    <strong>{props.value}</strong>
    <span>{props.label}</span>
  </div>
);

type SnapshotSection<A> =
  | { readonly _tag: "Available"; readonly items: ReadonlyArray<A> }
  | { readonly _tag: "Unavailable"; readonly reason: string };

/** A snapshot section: one row per item, or why its source did not answer. */
const Section = <A,>(props: {
  title: string;
  section: SnapshotSection<A>;
  key: (item: A) => string | number;
  grid?: boolean;
  children: (item: Accessor<A>) => JSX.Element;
}) => (
  <section>
    <h2>{props.title}</h2>
    <Show
      when={props.section._tag === "Unavailable" ? props.section.reason : null}
      fallback={
        <div class={props.grid ? "grid" : "rows"}>
          <For
            each={available(props.section)}
            keyed={props.key}
            fallback={<p class="muted">none</p>}
          >
            {(item) => props.children(item)}
          </For>
        </div>
      }
    >
      {(reason) => <p class="bad">unavailable: {reason()}</p>}
    </Show>
  </section>
);

const NodeCard = (props: { node: NodeStatus }) => (
  <article class="card">
    <h3>
      {props.node.name}{" "}
      <span class={props.node.status === "ready" ? "good" : "bad"}>{props.node.status}</span>
      <Show when={!props.node.eligible}>
        <span class="warn"> ineligible</span>
      </Show>
    </h3>
    <Meter
      label="cpu used"
      fraction={props.node.cpuPercent === null ? null : props.node.cpuPercent / 100}
    />
    <Show when={props.node.memoryBytes} fallback={<Meter label="memory used" fraction={null} />}>
      {(memory) => (
        <Meter
          label="memory used"
          fraction={memory().used / memory().total}
          detail={`${gib(memory().used)} of ${gib(memory().total)}`}
        />
      )}
    </Show>
    <Meter
      label="memory reserved"
      fraction={props.node.reservedMemoryMB.used / props.node.reservedMemoryMB.total}
      detail={`${props.node.reservedMemoryMB.used} of ${props.node.reservedMemoryMB.total} MB`}
    />
    <Meter
      label="cpu reserved"
      fraction={props.node.reservedCpuShares.used / props.node.reservedCpuShares.total}
      detail={`${props.node.reservedCpuShares.used} of ${props.node.reservedCpuShares.total} MHz`}
    />
    <For
      each={props.node.disks.filter((disk) => disk.mount !== "/nix/store")}
      keyed={(disk) => disk.mount}
    >
      {(disk) => (
        <Meter
          label={`disk ${disk().mount}`}
          fraction={disk().bytes.used / disk().bytes.total}
          detail={`${gib(disk().bytes.used)} of ${gib(disk().bytes.total)}`}
        />
      )}
    </For>
  </article>
);

/** A bar for a share of a whole; null when the node did not measure it. */
const Meter = (props: { label: string; fraction: number | null; detail?: string }) => {
  const percent = () => (props.fraction === null ? null : Math.round(props.fraction * 100));
  return (
    <div class="meter">
      <span>{props.label}</span>
      <div class="bar">
        <div class={`fill ${level(percent())}`} style={{ width: `${percent() ?? 0}%` }} />
      </div>
      <span class="num">{percent() === null ? "?" : `${percent()}%`}</span>
      <span class="muted detail">{props.detail ?? ""}</span>
    </div>
  );
};

const JobRow = (props: { job: JobStatus }) => (
  <article class="job">
    <div class="line">
      <span class={`dot ${healthTone[props.job.health]}`} title={props.job.health} />
      <strong>{props.job.name}</strong>
      <span class="muted">{props.job.type}</span>
      <span>{counts(props.job)}</span>
      <span class="muted">{props.job.version === null ? "" : `v${props.job.version}`}</span>
      <span class="image muted" title={props.job.images.join("\n")}>
        {props.job.images.map(shortImage).join(" ")}
      </span>
    </div>
    <For each={props.job.blockedBy}>{(reason) => <p class="warn indent">waiting: {reason}</p>}</For>
    <For each={props.job.checks.filter((check) => check.status !== "success")}>
      {(check) => (
        <p class="bad indent">
          check {check.service}: {check.status}
        </p>
      )}
    </For>
    <For each={props.job.allocations} keyed={(allocation) => allocation.id}>
      {(allocation) => <AllocationRows allocation={allocation()} />}
    </For>
  </article>
);

/** One line per task of a live allocation: where it runs, since when, and its newest event. */
const AllocationRows = (props: { allocation: AllocationStatus }) => (
  <For each={props.allocation.tasks} keyed={(task) => task.name}>
    {(task) => (
      <div class="alloc indent">
        <code>{props.allocation.id.slice(0, 8)}</code>
        <span>{props.allocation.node}</span>
        <span class="muted">v{props.allocation.version}</span>
        <span>{task().name}</span>
        <span class={task().state === "running" ? "good" : "warn"}>{task().state}</span>
        <span class="muted">since {ago(task().startedAt ?? props.allocation.createdAt)}</span>
        <span class={task().restarts > 0 ? "warn" : "muted"}>
          {task().restarts === 1 ? "1 restart" : `${task().restarts} restarts`}
        </span>
        <Show when={task().lastEvent}>
          {(event) => (
            <span class="muted event">
              {event().message || event().type} ({ago(event().at)})
            </span>
          )}
        </Show>
      </div>
    )}
  </For>
);

const RunnerRow = (props: { job: RunnerJob }) => (
  <div class="runner">
    <code>#{props.job.id}</code>
    <span class={stateTone[props.job.state]}>{props.job.state}</span>
    <strong>{props.job.command}</strong>
    <span>{props.job.subject ?? ""}</span>
    <span class="muted">{ago(props.job.createdAt)}</span>
    <span class="muted">{duration(props.job)}</span>
    <Show when={props.job.exitCode !== null && props.job.exitCode !== 0}>
      <span class="bad">exit {props.job.exitCode}</span>
    </Show>
  </div>
);

const AppRow = (props: { app: AppRelease }) => (
  <div class="app">
    <strong>{props.app.name}</strong>
    <span class="muted">#{props.app.deployment}</span>
    <code>{props.app.revision.slice(0, 8)}</code>
    <span class="muted">{ago(props.app.deployedAt)}</span>
    <span>{props.app.jobs.join(", ")}</span>
  </div>
);

const available = <A,>(section: SnapshotSection<A>): ReadonlyArray<A> =>
  section._tag === "Available" ? section.items : [];

const restarts = (job: JobStatus) =>
  job.allocations.reduce(
    (sum, allocation) => sum + allocation.tasks.reduce((n, task) => n + task.restarts, 0),
    0,
  );

const healthTone: Record<JobStatus["health"], string> = {
  healthy: "good",
  degraded: "warn",
  down: "bad",
  stopped: "muted",
};

const stateTone: Record<RunnerJob["state"], string> = {
  queued: "warn",
  starting: "warn",
  running: "warn",
  succeeded: "good",
  failed: "bad",
  interrupted: "bad",
  canceled: "muted",
};

const finished = new Set<RunnerJob["state"]>(["succeeded", "failed", "interrupted", "canceled"]);

// Bars turn amber at 75% and red at 90%.
const level = (percent: number | null) =>
  percent === null ? "muted" : percent >= 90 ? "bad" : percent >= 75 ? "warn" : "good";

const counts = (job: JobStatus) =>
  [
    `${job.running} running`,
    ...(job.starting > 0 ? [`${job.starting} starting`] : []),
    ...(job.queued > 0 ? [`${job.queued} queued`] : []),
  ].join(", ");

// "registry.cluster:5000/giglist@sha256:669d73ef…" -> "giglist@669d73ef".
const shortImage = (image: string) => {
  const [name = image, digest] = image.split("@sha256:");
  const short = name.split("/").at(-1) ?? name;
  return digest === undefined ? short : `${short}@${digest.slice(0, 8)}`;
};

const gib = (bytes: number) => `${(bytes / 2 ** 30).toFixed(1)} GiB`;

const clock = (iso: string) => new Date(iso).toLocaleTimeString();

const ago = (iso: string) => {
  const seconds = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000));
  if (seconds < 90) return `${seconds}s ago`;
  if (seconds < 90 * 60) return `${Math.round(seconds / 60)}m ago`;
  if (seconds < 36 * 3600) return `${Math.round(seconds / 3600)}h ago`;
  return `${Math.round(seconds / 86400)}d ago`;
};

const duration = (job: RunnerJob) => {
  if (job.startedAt === null) return "";
  const end = job.finishedAt === null ? Date.now() : Date.parse(job.finishedAt);
  const seconds = Math.round((end - Date.parse(job.startedAt)) / 1000);
  return seconds < 120 ? `${seconds}s` : `${Math.round(seconds / 60)}m`;
};

render(() => <App />, document.getElementById("app")!);
Effect.runFork(poll);
