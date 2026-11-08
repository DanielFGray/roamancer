import * as Alchemy from "alchemy";
import { isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import { Effect, Option, Redacted, Schema as S } from "effect";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";
import { KvKey, ResourceName } from "./Job.ts";
import { Nomad } from "./Nomad.ts";
import { OpenBao } from "./OpenBao.ts";
import {
  dependencyRegistrationRetry,
  firstServiceLocation,
  type RegistrationRetry,
} from "./ServiceRegistration.ts";

/**
 * One OpenObserve dashboard in the export format of OpenObserve's dashboard page (version 8).
 * Only the keys a dashboard needs are checked; every other key goes to OpenObserve as it is.
 */
export const DashboardDocument = S.StructWithRest(
  S.Struct({
    version: S.Literal(8),
    title: S.NonEmptyString,
    description: S.String,
    tabs: S.Array(S.Unknown),
  }),
  [S.Record(S.String, S.Unknown)],
);
export type DashboardDocument = typeof DashboardDocument.Type;

export const OpenObserveDashboardProps = S.Struct({
  // The Nomad service of the OpenObserve server.
  server: ResourceName,
  // An OpenObserve service account; its token is its password.
  username: S.String,
  token: KvKey,
  dashboard: DashboardDocument,
});
export type OpenObserveDashboardProps = typeof OpenObserveDashboardProps.Type;

/** OpenObserve's ID for the dashboard and the version stamp of the content it last saved. */
export type DashboardAttributes = { readonly dashboardId: string; readonly hash: string };

export interface OpenObserveDashboard extends Alchemy.Resource<
  "OpenObserve.Dashboard",
  OpenObserveDashboardProps,
  DashboardAttributes
> {}
export const OpenObserveDashboard = Alchemy.Resource<OpenObserveDashboard>("OpenObserve.Dashboard");

export class OpenObserveError extends S.TaggedError<OpenObserveError>()("OpenObserveError", {
  operation: S.String,
  target: S.String,
}) {
  override get message() {
    return `OpenObserve ${this.operation} failed for ${this.target}`;
  }
}

/**
 * OpenObserve assigns each dashboard its ID and changes its hash on every save, in the UI as
 * well as through the API. So a plan compares the live hash with the stored one: a dashboard
 * that was edited by hand or lost with OpenObserve's data shows as an update, and the deploy
 * writes the repository's version back.
 */
export const OpenObserveDashboardProvider = () =>
  Provider.effect(
    OpenObserveDashboard,
    Effect.gen(function* () {
      const nomad = yield* Nomad;
      const openBao = yield* OpenBao;
      const http = yield* HttpClient.HttpClient;

      const connect = Effect.fn("OpenObserveDashboard.connect")(function* (
        props: OpenObserveDashboardProps,
        retry: RegistrationRetry = dependencyRegistrationRetry,
      ) {
        const location = yield* firstServiceLocation(
          props.server,
          nomad.service(props.server),
          retry,
        ).pipe(
          Effect.mapError(
            () => new OpenObserveError({ operation: "find service", target: props.server }),
          ),
        );
        const token = yield* openBao.readKv(props.token.path, props.token.key);
        return dashboardClient(http, {
          baseUrl: `http://${location.Address}:${location.Port}`,
          username: props.username,
          token,
        });
      });

      return OpenObserveDashboard.Provider.of({
        list: () => Effect.succeed([]),
        // A plan looks once and briefly. Waiting for OpenObserve, or failing the plan, would
        // block the deploy that repairs it; the deploy's reconcile waits instead.
        diff: Effect.fn(function* ({ news, output }) {
          if (!isResolved(news) || output === undefined) return undefined;
          const unchanged = yield* connect(news, { times: 0, spacing: "0 seconds" }).pipe(
            Effect.flatMap((client) => isUnchanged(client, output)),
            Effect.orElseSucceed(() => false),
          );
          return unchanged ? undefined : { action: "update" as const };
        }),
        reconcile: Effect.fn(function* ({ news, output }) {
          const client = yield* connect(news);
          return yield* saveDashboard(client, Option.fromNullishOr(output), news.dashboard);
        }),
        read: Effect.fn(function* ({ olds, output }) {
          if (output === undefined) return undefined;
          const client = yield* connect(olds);
          return Option.getOrUndefined(yield* client.get(output.dashboardId));
        }),
        delete: Effect.fn(function* ({ olds, output }) {
          const client = yield* connect(olds);
          yield* client.remove(output.dashboardId);
        }),
      });
    }),
  );

/**
 * True while OpenObserve holds the dashboard `stored` names with the hash `stored` records.
 * A dashboard that is gone, was saved since, or cannot be read within 10 seconds is changed.
 */
export const isUnchanged = (client: DashboardClient, stored: DashboardAttributes) =>
  client.get(stored.dashboardId).pipe(
    Effect.timeout("10 seconds"),
    Effect.map(Option.exists((live) => live.hash === stored.hash)),
    Effect.orElseSucceed(() => false),
  );

/**
 * Write `dashboard` over the one OpenObserve holds under `stored`, or create it when there is
 * none: on the first deploy, and after OpenObserve lost its data.
 */
export const saveDashboard = Effect.fn("OpenObserveDashboard.save")(function* (
  client: DashboardClient,
  stored: Option.Option<DashboardAttributes>,
  dashboard: DashboardDocument,
) {
  const live = yield* Option.match(stored, {
    onNone: () => Effect.succeed(Option.none<DashboardAttributes>()),
    onSome: (attributes) => client.get(attributes.dashboardId),
  });
  return yield* Option.match(live, {
    onNone: () => client.create(dashboard),
    onSome: (current) => client.update(current, dashboard),
  });
});

export type DashboardClient = ReturnType<typeof dashboardClient>;

// OpenObserve's open-source build has the one organization, and the UI opens the default folder.
const organization = "default";
const folder = "default";
const dashboards = `/api/${organization}/dashboards`;

/** Where OpenObserve's UI at `baseUrl` opens a saved dashboard. */
export const viewUrl = (baseUrl: string, dashboardId: string): string => {
  const url = new URL("/web/dashboards/view", baseUrl);
  url.search = new URLSearchParams({
    org_identifier: organization,
    dashboard: dashboardId,
    folder,
  }).toString();
  return url.toString();
};

const Saved = S.Struct({ hash: S.String, v8: S.Struct({ dashboardId: S.String }) });

/** The dashboard API of one OpenObserve server, as one service account. */
export const dashboardClient = (
  http: HttpClient.HttpClient,
  server: {
    readonly baseUrl: string;
    readonly username: string;
    readonly token: Redacted.Redacted<string>;
  },
) => {
  const client = http.pipe(
    HttpClient.mapRequest(HttpClientRequest.prependUrl(server.baseUrl)),
    HttpClient.mapRequest(HttpClientRequest.basicAuth(server.username, server.token)),
  );
  const failure = (operation: string, target: string) => () =>
    new OpenObserveError({ operation, target });
  const saved =
    (operation: string, target: string) => (response: HttpClientResponse.HttpClientResponse) =>
      HttpClientResponse.filterStatusOk(response).pipe(
        Effect.flatMap(HttpClientResponse.schemaBodyJson(Saved)),
        Effect.map((body) => ({ dashboardId: body.v8.dashboardId, hash: body.hash })),
        Effect.mapError(failure(operation, target)),
      );
  const send = (
    operation: string,
    target: string,
    request: HttpClientRequest.HttpClientRequest,
    dashboard: DashboardDocument,
  ) =>
    HttpClientRequest.bodyJson(request, dashboard).pipe(
      Effect.flatMap(client.execute),
      Effect.mapError(failure(operation, target)),
      Effect.flatMap(saved(operation, target)),
    );

  return {
    /** The dashboard's current hash; None when OpenObserve has no dashboard with this ID. */
    get: (dashboardId: string) =>
      client.execute(HttpClientRequest.get(`${dashboards}/${dashboardId}`)).pipe(
        Effect.mapError(failure("read dashboard", dashboardId)),
        Effect.flatMap((response) =>
          response.status === 404
            ? Effect.succeed(Option.none<DashboardAttributes>())
            : saved("read dashboard", dashboardId)(response).pipe(Effect.map(Option.some)),
        ),
      ),
    create: (dashboard: DashboardDocument) =>
      send(
        "create dashboard",
        dashboard.title,
        HttpClientRequest.post(dashboards).pipe(HttpClientRequest.setUrlParam("folder", folder)),
        dashboard,
      ),
    /** Replace the content saved as `current`. OpenObserve refuses it once the hash has changed. */
    update: (current: DashboardAttributes, dashboard: DashboardDocument) =>
      send(
        "update dashboard",
        dashboard.title,
        HttpClientRequest.put(`${dashboards}/${current.dashboardId}`).pipe(
          HttpClientRequest.setUrlParams({ folder, hash: current.hash }),
        ),
        dashboard,
      ),
    /** Delete the dashboard; one that is already gone counts as deleted. */
    remove: (dashboardId: string) =>
      client
        .execute(
          HttpClientRequest.delete(`${dashboards}/${dashboardId}`).pipe(
            HttpClientRequest.setUrlParam("folder", folder),
          ),
        )
        .pipe(
          Effect.flatMap((response) =>
            response.status === 404
              ? Effect.void
              : HttpClientResponse.filterStatusOk(response).pipe(Effect.asVoid),
          ),
          Effect.mapError(failure("delete dashboard", dashboardId)),
        ),
  };
};
