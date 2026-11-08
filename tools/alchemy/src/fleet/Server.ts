/**
 * The fleet service on the control host: FleetApi on loopback and, when `webRoot` is set,
 * the fleet page's built files. It runs as the runner user, which alone can read the
 * deployment record, the job queue and Alchemy's state, with a read-only Nomad token.
 *
 * Viewers that ask within a few seconds of each other share one snapshot read, so each
 * open page does not add its own round of Nomad requests.
 */
import * as BunHttpServer from "@effect/platform-bun/BunHttpServer";
import { Effect, Layer, Option } from "effect";
import { HttpRouter, HttpStaticServer } from "effect/http";
import { HttpApiBuilder } from "effect/http-api";
import * as FleetStatus from "../FleetStatus.ts";
import { FleetApi, port } from "./Api.ts";

const snapshotTtl = "5 seconds";

/** The server; it needs Nomad, Deployments, the queue Store and Alchemy's State for the snapshot. */
export const layer = (options: { readonly webRoot: Option.Option<string> }) =>
  HttpRouter.serve(
    Layer.mergeAll(
      HttpApiBuilder.layer(FleetApi).pipe(Layer.provide(handlers)),
      Option.match(options.webRoot, {
        onNone: () => Layer.empty,
        onSome: (root) => HttpStaticServer.layer({ root, spa: true }),
      }),
    ),
    // Each open page asks every few seconds; a log line per request would fill the journal.
    { disableLogger: true },
  ).pipe(Layer.provide(BunHttpServer.layer({ port, hostname: "127.0.0.1" })));

const handlers = HttpApiBuilder.group(
  FleetApi,
  "fleet",
  Effect.fnUntraced(function* (handlers) {
    const snapshot = yield* Effect.cachedWithTTL(FleetStatus.snapshot(), snapshotTtl);
    return handlers.handle("snapshot", () => snapshot);
  }),
);
