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
import {
  type AllocationStatus,
  type AppRow as AppRowItem,
  appRows,
  type DashboardLink,
  type Endpoint,
  jobDashboardUrl,
  type JobStatus,
  type NodeStatus,
  type RunnerJob,
  type Snapshot,
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
  <>
    <header class="topbar">
      <div class="topbar-inner">
        <h1>
          <span class="mark" aria-hidden="true" />
          Fleet
        </h1>
        <span class={`live ${failure() === null ? "" : "lost"}`}>
          <span class="pulse" aria-hidden="true" />
          {snapshot() === null
            ? "loading"
            : failure() === null
              ? `live · ${clock(snapshot()!.takenAt)}`
              : `stale · ${clock(snapshot()!.takenAt)}`}
        </span>
        <Show when={snapshot()}>{(taken) => <Dashboards section={taken().dashboards} />}</Show>
      </div>
    </header>
    <main>
      <Show when={failure()}>
        {(message) => <p class="banner bad">Cannot reach the fleet service: {message()}</p>}
      </Show>
      <Show when={snapshot()}>
        {(taken) => (
          <>
            <Summary snapshot={taken()} />
            <div class="columns">
              <div class="column">
                <Section
                  title="Apps"
                  section={mapSection(taken().apps, (releases) =>
                    appRows(releases, available(taken().endpoints)),
                  )}
                  key={(app) => app.name}
                  layout="cards"
                >
                  {(app) => <AppCard app={app()} />}
                </Section>
                <Section title="Jobs" section={taken().jobs} key={(job) => job.name} layout="rows">
                  {(job) => (
                    <JobRow
                      job={job()}
                      dashboards={available(taken().dashboards)}
                      endpoints={available(taken().endpoints)}
                    />
                  )}
                </Section>
              </div>
              <aside class="column">
                <Section
                  title="Nodes"
                  section={taken().nodes}
                  key={(node) => node.name}
                  layout="stack"
                >
                  {(node) => <NodeCard node={node()} />}
                </Section>
                <Section
                  title="Runner jobs"
                  section={taken().runner}
                  key={(job) => job.id}
                  layout="rows"
                >
                  {(job) => <RunnerRow job={job()} />}
                </Section>
              </aside>
            </div>
          </>
        )}
      </Show>
    </main>
  </>
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
  <div class={`stat ${props.value > 0 ? props.tone : "quiet"}`}>
    <strong>{props.value}</strong>
    <span>{props.label}</span>
  </div>
);

/** A link to each deployed OpenObserve dashboard, or why the page has none. */
const Dashboards = (props: { section: SnapshotSection<DashboardLink> }) => (
  <nav class="dashboards">
    <Show
      when={props.section._tag === "Available"}
      fallback={
        <span class="warn">
          dashboards unavailable: {props.section._tag === "Unavailable" && props.section.reason}
        </span>
      }
    >
      <For each={available(props.section)} keyed={(dashboard) => dashboard.name}>
        {(dashboard) => (
          <a class="button" href={dashboard().url} target="_blank" rel="noreferrer">
            <ChartIcon />
            {dashboard().title}
          </a>
        )}
      </For>
    </Show>
  </nav>
);

type SnapshotSection<A> =
  | { readonly _tag: "Available"; readonly items: ReadonlyArray<A> }
  | { readonly _tag: "Unavailable"; readonly reason: string };

/**
 * A snapshot section: its items, or why its source did not answer. `rows` joins the items
 * in one panel; `cards` and `stack` give each item its own panel, in a grid or a column.
 */
const Section = <A,>(props: {
  title: string;
  section: SnapshotSection<A>;
  key: (item: A) => string | number;
  layout: "rows" | "cards" | "stack";
  children: (item: Accessor<A>) => JSX.Element;
}) => (
  <section class="section">
    <h2>
      {props.title}
      <Show when={props.section._tag === "Available"}>
        <span class="count">{available(props.section).length}</span>
      </Show>
    </h2>
    <Show
      when={props.section._tag === "Unavailable" ? props.section.reason : null}
      fallback={
        <div class={props.layout}>
          <For
            each={available(props.section)}
            keyed={props.key}
            fallback={<p class="empty">none</p>}
          >
            {(item) => props.children(item)}
          </For>
        </div>
      }
    >
      {(reason) => <p class="banner bad">unavailable: {reason()}</p>}
    </Show>
  </section>
);

const AppCard = (props: { app: AppRowItem }) => (
  <article class="panel app">
    <div class="app-head">
      <h3>{props.app.name}</h3>
      <Show when={props.app.release} fallback={<span class="pill quiet">not released</span>}>
        {(release) => (
          <span class="release">
            <span class="pill">#{release().deployment}</span>
            <code>{release().revision.slice(0, 8)}</code>
            <span class="muted">{ago(release().deployedAt)}</span>
          </span>
        )}
      </Show>
    </div>
    <Show when={props.app.live.urls.length > 0}>
      <div class="links">
        <Links urls={props.app.live.urls} />
      </div>
    </Show>
    <Show when={props.app.release}>
      {(release) => <p class="jobs muted">{release().jobs.join(" · ")}</p>}
    </Show>
    <For each={props.app.previews}>
      {(preview) => (
        <div class="preview">
          <span class="pill accent">staged</span>
          <span class="muted">{preview.stage}</span>
          <Show when={preview.revision}>{(revision) => <code>{revision().slice(0, 8)}</code>}</Show>
          <Links urls={preview.urls} />
        </div>
      )}
    </For>
  </article>
);

const JobRow = (props: {
  job: JobStatus;
  dashboards: ReadonlyArray<DashboardLink>;
  endpoints: ReadonlyArray<Endpoint>;
}) => (
  <article class="job">
    <div class="job-head">
      <span class={`dot ${healthTone[props.job.health]}`} title={props.job.health} />
      <strong class="name">{props.job.name}</strong>
      <span class="pill quiet">{props.job.type}</span>
      <span class="muted">{counts(props.job)}</span>
      <Show when={props.job.version !== null}>
        <span class="muted">v{props.job.version}</span>
      </Show>
      <span class="actions">
        <Links
          urls={props.endpoints
            .filter((endpoint) => endpoint.job === props.job.name)
            .map((endpoint) => endpoint.url)}
        />
        <Show when={jobDashboardUrl(props.dashboards, props.job.name)}>
          {(url) => (
            <a class="chip" href={url()} target="_blank" rel="noreferrer" title="OpenObserve">
              <ChartIcon />
              metrics
            </a>
          )}
        </Show>
      </span>
    </div>
    <code class="image" title={props.job.images.join("\n")}>
      {props.job.images.map(shortImage).join(" ")}
    </code>
    <For each={props.job.blockedBy}>{(reason) => <p class="note warn">waiting: {reason}</p>}</For>
    <For each={props.job.checks.filter((check) => check.status !== "success")}>
      {(check) => (
        <p class="note bad">
          check {check.service}: {check.status}
        </p>
      )}
    </For>
    <div class="allocs">
      <For each={props.job.allocations} keyed={(allocation) => allocation.id}>
        {(allocation) => <AllocationRows allocation={allocation()} />}
      </For>
    </div>
  </article>
);

/** One line per task of a live allocation: where it runs, since when, and its newest event. */
const AllocationRows = (props: { allocation: AllocationStatus }) => (
  <For each={props.allocation.tasks} keyed={(task) => task.name}>
    {(task) => (
      <div class="alloc">
        <code class="muted">{props.allocation.id.slice(0, 8)}</code>
        <span>{props.allocation.node}</span>
        <span>{task().name}</span>
        <span class={`pill ${task().state === "running" ? "good" : "warn"}`}>{task().state}</span>
        <span class="muted">{ago(task().startedAt ?? props.allocation.createdAt)}</span>
        <span class="warn">
          {task().restarts === 0
            ? ""
            : task().restarts === 1
              ? "1 restart"
              : `${task().restarts} restarts`}
        </span>
        <span class="muted event">
          <Show when={task().lastEvent}>{(event) => event().message || event().type}</Show>
        </span>
      </div>
    )}
  </For>
);

const NodeCard = (props: { node: NodeStatus }) => (
  <article class="panel node">
    <div class="node-head">
      <h3>{props.node.name}</h3>
      <span class={`pill ${props.node.status === "ready" ? "good" : "bad"}`}>
        {props.node.status}
      </span>
      <Show when={!props.node.eligible}>
        <span class="pill warn">ineligible</span>
      </Show>
    </div>
    <Meter
      label="CPU used"
      fraction={props.node.cpuPercent === null ? null : props.node.cpuPercent / 100}
    />
    <Show when={props.node.memoryBytes} fallback={<Meter label="Memory used" fraction={null} />}>
      {(memory) => (
        <Meter
          label="Memory used"
          fraction={memory().used / memory().total}
          detail={`${gib(memory().used)} / ${gib(memory().total)}`}
        />
      )}
    </Show>
    <Meter
      label="CPU reserved"
      fraction={props.node.reservedCpuShares.used / props.node.reservedCpuShares.total}
      detail={`${props.node.reservedCpuShares.used} / ${props.node.reservedCpuShares.total} MHz`}
    />
    <Meter
      label="Memory reserved"
      fraction={props.node.reservedMemoryMB.used / props.node.reservedMemoryMB.total}
      detail={`${props.node.reservedMemoryMB.used} / ${props.node.reservedMemoryMB.total} MB`}
    />
    <For
      each={props.node.disks.filter((disk) => disk.mount !== "/nix/store")}
      keyed={(disk) => disk.mount}
    >
      {(disk) => (
        <Meter
          label={`Disk ${disk().mount}`}
          fraction={disk().bytes.used / disk().bytes.total}
          detail={`${gib(disk().bytes.used)} / ${gib(disk().bytes.total)}`}
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
      <span class="label">{props.label}</span>
      <span class="muted detail">{props.detail ?? ""}</span>
      <span class={`num ${level(percent())}`}>{percent() === null ? "?" : `${percent()}%`}</span>
      <div class="bar">
        <div class={`fill ${level(percent())}`} style={{ width: `${percent() ?? 0}%` }} />
      </div>
    </div>
  );
};

const RunnerRow = (props: { job: RunnerJob }) => (
  <div class="runner">
    <span class={`dot ${stateTone[props.job.state]}`} title={props.job.state} />
    <strong>{props.job.command}</strong>
    <span class="subject" title={props.job.subject ?? ""}>
      {props.job.subject ?? ""}
    </span>
    <span class="when muted">
      <Show when={props.job.exitCode !== null && props.job.exitCode !== 0}>
        <span class="bad">exit {props.job.exitCode} · </span>
      </Show>
      {ago(props.job.createdAt)}
      <Show when={duration(props.job)}>{(took) => ` · ${took()}`}</Show>
    </span>
  </div>
);

/** One chip per address. Its full URL is the chip's tooltip. */
const Links = (props: { urls: ReadonlyArray<string> }) => (
  <For each={props.urls}>
    {(url) => (
      <a class="chip" href={url} target="_blank" rel="noreferrer" title={url}>
        {linkLabel(url)}
        <ExternalIcon />
      </a>
    )}
  </For>
);

// Tailnet addresses share the control host's Serve name and differ only by port.
const linkLabel = (url: string) => {
  const parsed = new URL(url);
  return parsed.hostname.endsWith(".ts.net") ? `tailnet :${parsed.port || "443"}` : parsed.host;
};

const ExternalIcon = () => (
  <svg class="icon" viewBox="0 0 16 16" aria-hidden="true">
    <path d="M6 3h7v7M13 3 4 12" />
  </svg>
);

const ChartIcon = () => (
  <svg class="icon" viewBox="0 0 16 16" aria-hidden="true">
    <path d="M2 13h12M4 10l3-3 2 2 4-5" />
  </svg>
);

const mapSection = <A, B>(
  section: SnapshotSection<A>,
  f: (items: ReadonlyArray<A>) => ReadonlyArray<B>,
): SnapshotSection<B> =>
  section._tag === "Available" ? { _tag: "Available", items: f(section.items) } : section;

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
  stopped: "quiet",
};

const stateTone: Record<RunnerJob["state"], string> = {
  queued: "warn",
  starting: "warn",
  running: "warn",
  succeeded: "good",
  failed: "bad",
  interrupted: "bad",
  canceled: "quiet",
};

const finished = new Set<RunnerJob["state"]>(["succeeded", "failed", "interrupted", "canceled"]);

// Bars turn amber at 75% and red at 90%.
const level = (percent: number | null) =>
  percent === null ? "quiet" : percent >= 90 ? "bad" : percent >= 75 ? "warn" : "good";

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
