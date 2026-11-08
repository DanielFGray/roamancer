/**
 * What Alchemy's state says each stage runs, for the fleet snapshot: where each job answers,
 * and where each OpenObserve dashboard opens.
 *
 * Only finished records count. The snapshot reads the state every few seconds, also while a
 * deploy writes it, and a resource that is still being created or replaced has no address
 * yet; it gets a link when its deploy ends. A finished record that does not decode fails the
 * read, so the page says why instead of leaving a link out.
 */
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as S from "effect/Schema";
import {
  type CreatedResourceState,
  isResourceState,
  type PersistedState,
  type StateService,
  type UpdatedResourceState,
} from "alchemy/State";
import { baseName } from "./Cartridge.ts";
import { dashboardResourcePrefix, serveResourceId } from "./Compose.ts";
import { Route } from "./Job.ts";
import { viewUrl } from "./OpenObserveDashboard.ts";
import * as Package from "./Package.ts";
import type { DashboardLink, Endpoint } from "./fleet/Snapshot.ts";

type Deployed = CreatedResourceState | UpdatedResourceState;

/** One stage's resource records, by logical ID. */
export interface DeployedStage {
  readonly stage: string;
  /** The records whose deploy finished. */
  readonly records: ReadonlyMap<string, Deployed>;
  /** The logical IDs of records that a deploy is still writing. */
  readonly pending: ReadonlySet<string>;
}

export class MissingState extends S.TaggedError<MissingState>()("MissingState", {
  stage: S.String,
  fqn: S.String,
}) {
  override get message() {
    return `Alchemy state has no ${this.fqn} in stage ${this.stage}`;
  }
}

/** Every stage of the stack, read once for all the sections that need the state. */
export const readStages = Effect.fn("DeployedStages.read")(function* (state: StateService) {
  const stack = Package.stack;
  return yield* Effect.forEach(
    yield* state.listStages(stack),
    (stage) =>
      state.list({ stack, stage }).pipe(
        Effect.flatMap(
          Effect.forEach((fqn) =>
            state.get({ stack, stage, fqn }).pipe(Effect.map((record) => ({ fqn, record }))),
          ),
        ),
        Effect.map((read): DeployedStage => {
          const records = new Map<string, Deployed>();
          const pending = new Set<string>();
          for (const { fqn, record } of read) {
            if (isDeployed(record)) records.set(fqn, record);
            else pending.add(fqn);
          }
          return { stage, records, pending };
        }),
      ),
    { concurrency: 4 },
  );
});

/**
 * Where each job answers: `https://<host>/` for each public route, and the Tailscale Serve
 * URL of its tailnet route. A staged copy's endpoints name the live app, so the page lists
 * them beside it.
 */
export const endpoints = (stages: ReadonlyArray<DeployedStage>) =>
  Effect.forEach(stages, (stage) =>
    Effect.forEach(ofType(stage, "Nomad.Job"), (record) =>
      Effect.gen(function* () {
        const job = (yield* S.decodeUnknownEffect(DeployedJob)(record)).props;
        const at = {
          app: Option.getOrElse(baseName(stage.stage), () => stage.stage),
          stage: stage.stage,
          job: job.name,
          revision: job.environment.find((entry) => entry.name === "GIT_COMMIT")?.value ?? null,
        };
        const routes = job.routes ?? [];
        const tailnet = routes.some((route) => route.access === "tailnet")
          ? Option.toArray(yield* serveUrl(stage, job.name))
          : [];
        return [
          ...routes.flatMap((route) =>
            route.access === "public"
              ? [{ ...at, access: "public" as const, url: `https://${route.host}/` }]
              : [],
          ),
          ...tailnet.map((url) => ({ ...at, access: "tailnet" as const, url })),
        ] satisfies ReadonlyArray<Endpoint>;
      }),
    ).pipe(Effect.map((perJob) => perJob.flat())),
  ).pipe(Effect.map((perStage) => perStage.flat()));

/** Each deployed dashboard, opened through the Tailscale Serve URL of the job that serves it. */
export const dashboards = (stages: ReadonlyArray<DeployedStage>) =>
  Effect.forEach(stages, (stage) =>
    Effect.forEach(ofType(stage, "OpenObserve.Dashboard"), (record) =>
      Effect.gen(function* () {
        const dashboard = yield* S.decodeUnknownEffect(DeployedDashboard)(record);
        const served = yield* serveUrl(stage, dashboard.props.server);
        return Option.toArray(served).map((url): DashboardLink => ({
          name: record.fqn.slice(dashboardResourcePrefix.length),
          title: dashboard.props.dashboard.title,
          url: viewUrl(url, dashboard.attr.dashboardId),
        }));
      }),
    ).pipe(Effect.map((perDashboard) => perDashboard.flat())),
  ).pipe(Effect.map((perStage) => perStage.flat()));

/**
 * The Serve URL of a job's tailnet route: none while a deploy writes the lease, and
 * MissingState when the stage has no lease, so the page says why a link is missing.
 */
const serveUrl = (stage: DeployedStage, job: string) => {
  const fqn = serveResourceId(job);
  const serve = stage.records.get(fqn);
  if (serve !== undefined) {
    return S.decodeUnknownEffect(DeployedServe)(serve).pipe(
      Effect.map((decoded) => Option.some(decoded.attr.url)),
    );
  }
  return stage.pending.has(fqn)
    ? Effect.succeed(Option.none<string>())
    : Effect.fail(new MissingState({ stage: stage.stage, fqn }));
};

const isDeployed = (record: PersistedState | undefined): record is Deployed =>
  isResourceState(record) && (record.status === "created" || record.status === "updated");

const ofType = (stage: DeployedStage, resourceType: string) =>
  [...stage.records.values()].filter((record) => record.resourceType === resourceType);

// Only the fields the fleet page reads; a record holds the resource's whole props.
const DeployedJob = S.Struct({
  props: S.Struct({
    name: S.String,
    routes: S.optionalKey(S.Array(Route)),
    // GIT_COMMIT is the app commit a release or stage sent (Cartridge.expand).
    environment: S.Array(S.Struct({ name: S.String, value: S.optionalKey(S.String) })),
  }),
});
const DeployedServe = S.Struct({ attr: S.Struct({ url: S.String }) });
const DeployedDashboard = S.Struct({
  props: S.Struct({
    server: S.String,
    dashboard: S.Struct({ title: S.String }),
  }),
  attr: S.Struct({ dashboardId: S.String }),
});
