import * as Config from "effect/Config";
import * as Arr from "effect/Array";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";

const CaddyMatch = Schema.Struct({ host: Schema.Array(Schema.String) });
const ReverseProxyHandler = Schema.Struct({
  handler: Schema.Literal("reverse_proxy"),
  upstreams: Schema.Array(Schema.Struct({ dial: Schema.String })),
});
const ReleaseHeaderHandler = Schema.Struct({
  handler: Schema.Literal("headers"),
  response: Schema.Struct({
    set: Schema.Struct({ "X-Alchemy-Release": Schema.Array(Schema.String) }),
  }),
});
const CaddyHandler = Schema.Union([ReverseProxyHandler, ReleaseHeaderHandler]);
const CaddyRoute = Schema.Struct({
  "@id": Schema.String,
  match: Schema.Array(CaddyMatch),
  handle: Schema.Array(CaddyHandler),
});
type CaddyRoute = typeof CaddyRoute.Type;

export class CaddyError extends Schema.TaggedError<CaddyError>()("CaddyError", {
  op: Schema.String,
  cause: Schema.Defect(),
}) {}

export class Caddy extends Context.Service<
  Caddy,
  {
    readonly route: (id: string) => Effect.Effect<Option.Option<CaddyRoute>, CaddyError>;
    readonly applyRoute: (route: CaddyRoute) => Effect.Effect<void, CaddyError>;
    readonly deleteRoute: (id: string) => Effect.Effect<void, CaddyError>;
    readonly routeTargets: (
      id: string,
      host: string,
      release: string,
      upstream: string,
    ) => Effect.Effect<boolean, CaddyError>;
  }
>()("alchemy/Caddy") {}

export const makeRoute = (
  id: string,
  host: string,
  release: string,
  upstream: string,
): CaddyRoute => ({
  "@id": id,
  match: [{ host: [host] }],
  handle: [
    { handler: "headers", response: { set: { "X-Alchemy-Release": [release] } } },
    { handler: "reverse_proxy", upstreams: [{ dial: upstream }] },
  ],
});

export const layer = () =>
  Layer.effect(
    Caddy,
    Effect.gen(function* () {
      const address = yield* Config.String("CADDY_ADMIN_ADDR");
      const http = (yield* HttpClient.HttpClient).pipe(
        HttpClient.mapRequest(HttpClientRequest.prependUrl(address)),
      );
      const call = (
        op: string,
        request: Effect.Effect<HttpClientRequest.HttpClientRequest, CaddyError>,
      ) =>
        request.pipe(
          Effect.flatMap(http.execute),
          Effect.mapError((cause) => new CaddyError({ op, cause })),
        );
      const request = (
        op: string,
        method: "GET" | "POST" | "PATCH" | "DELETE",
        path: string,
        body?: CaddyRoute,
      ) =>
        (body === undefined
          ? Effect.succeed(HttpClientRequest.make(method)(path))
          : HttpClientRequest.make(method)(path).pipe(
              HttpClientRequest.bodyJson(body),
              Effect.mapError((cause) => new CaddyError({ op, cause })),
            )
        )
          .pipe(
            Effect.map(HttpClientRequest.setHeader("Origin", address)),
            Effect.flatMap((request) => call(op, Effect.succeed(request))),
          )
          .pipe(
            Effect.flatMap((response) =>
              response.status === 404 && method === "GET"
                ? Effect.succeed(Option.none<HttpClientResponse.HttpClientResponse>())
                : HttpClientResponse.filterStatusOk(response).pipe(
                    Effect.mapError((cause) => new CaddyError({ op, cause })),
                    Effect.map(Option.some),
                  ),
            ),
          );
      const route = (id: string) =>
        request("route", "GET", `/id/${encodeURIComponent(id)}`).pipe(
          Effect.flatMap(
            Option.match({
              onNone: () => Effect.succeed(Option.none<CaddyRoute>()),
              onSome: (response) =>
                HttpClientResponse.schemaBodyJson(CaddyRoute)(response).pipe(
                  Effect.mapError((cause) => new CaddyError({ op: "route", cause })),
                  Effect.map(Option.some),
                ),
            }),
          ),
        );
      const write = (
        op: string,
        method: "POST" | "PATCH" | "DELETE",
        path: string,
        body?: CaddyRoute,
      ) => request(op, method, path, body).pipe(Effect.asVoid);

      return Caddy.of({
        route,
        applyRoute: Effect.fn(function* (desired) {
          const current = yield* route(desired["@id"]);
          yield* Option.match(current, {
            onNone: () =>
              write("append route", "POST", "/config/apps/http/servers/srv0/routes", desired),
            onSome: () =>
              write("replace route", "PATCH", `/id/${encodeURIComponent(desired["@id"])}`, desired),
          });
        }),
        deleteRoute: Effect.fn(function* (id) {
          const current = yield* route(id);
          yield* Option.match(current, {
            onNone: () => Effect.void,
            onSome: () => write("delete route", "DELETE", `/id/${encodeURIComponent(id)}`),
          });
        }),
        routeTargets: Effect.fn(function* (id, host, release, upstream) {
          const current = yield* route(id);
          return Option.match(current, {
            onNone: () => false,
            onSome: (value) => {
              const match = value.match[0];
              const header = Arr.findFirst(
                value.handle,
                (handler) => handler.handler === "headers",
              );
              const proxy = Arr.findFirst(
                value.handle,
                (handler) => handler.handler === "reverse_proxy",
              );
              return (
                value["@id"] === id &&
                match?.host[0] === host &&
                Option.match(header, {
                  onNone: () => false,
                  onSome: (handler) => handler.response.set["X-Alchemy-Release"][0] === release,
                }) &&
                Option.match(proxy, {
                  onNone: () => false,
                  onSome: (handler) => handler.upstreams[0]?.dial === upstream,
                })
              );
            },
          });
        }),
      });
    }),
  );
