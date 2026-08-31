import { Effect, Context, Layer, Schema as S } from "effect";
import * as HttpClient from "@effect/platform/HttpClient";
import * as HttpClientRequest from "@effect/platform/HttpClientRequest";
import * as HttpClientError from "@effect/platform/HttpClientError";
import * as HttpBody from "@effect/platform/HttpBody";
import type { ParseError } from "effect/ParseResult";
import { SshClient, type SshError } from "./SshClient.ts";
import { SVC_USER } from "../lib/config.ts";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface ConsulConfig {
  readonly addr: string;
}

// ---------------------------------------------------------------------------
// Request and response types
// ---------------------------------------------------------------------------

export interface ConsulTcpCheck {
  readonly TCP: string;
  readonly Interval: string;
  readonly Timeout?: string;
}

export interface ConsulHttpCheck {
  readonly HTTP: string;
  readonly Interval: string;
  readonly Timeout?: string;
}

export interface ConsulScriptCheck {
  readonly Args: ReadonlyArray<string>;
  readonly Interval: string;
  readonly Timeout?: string;
}

export type ConsulCheck = ConsulTcpCheck | ConsulHttpCheck | ConsulScriptCheck;

export interface ConsulServiceDefinition {
  readonly Name: string;
  readonly ID: string;
  readonly Port: number;
  readonly Address?: string;
  readonly Check: ConsulCheck;
}

export interface ConsulCatalogEntry {
  readonly Node: string;
  readonly Address: string;
  readonly ServiceAddress: string;
  readonly ServicePort: number;
}

export interface ConsulHealthEntry {
  readonly Checks: ReadonlyArray<{ readonly Status: string }>;
}

// ---------------------------------------------------------------------------
// Error type
// ---------------------------------------------------------------------------

export type ConsulError =
  | HttpClientError.HttpClientError
  | HttpBody.HttpBodyError
  | ParseError
  | SshError;

export class ConsulServiceNotFoundError extends S.TaggedError<ConsulServiceNotFoundError>()(
  "ConsulServiceNotFoundError",
  { service: S.String },
) {
  override get message() {
    return `Consul service not found: ${this.service}`;
  }
}

// ---------------------------------------------------------------------------
// Service (parameterized — uses Context.Tag, not Effect.Service)
// ---------------------------------------------------------------------------

export interface ConsulClientShape {
  // Registration is a PUT against the target's own agent (see the comment on
  // `make` below for why this can't go through the shared HTTP client).
  readonly registerService: (
    definition: ConsulServiceDefinition,
    host: string,
  ) => Effect.Effect<void, ConsulError>;
  readonly deregisterService: (id: string, host: string) => Effect.Effect<void, ConsulError>;
  readonly catalogService: (
    name: string,
  ) => Effect.Effect<ReadonlyArray<ConsulCatalogEntry>, ConsulError>;
  readonly resolveServiceHost: (
    name: string,
  ) => Effect.Effect<string, ConsulError | ConsulServiceNotFoundError>;
  readonly serviceIsPassing: (name: string) => Effect.Effect<boolean, ConsulError>;
}

export class ConsulClient extends Context.Tag("infra/ConsulClient")<
  ConsulClient,
  ConsulClientShape
>() {}

// ---------------------------------------------------------------------------
// Parameterized construction
// ---------------------------------------------------------------------------

export const make = Effect.fnUntraced(function* (config: ConsulConfig) {
  const baseClient = yield* HttpClient.HttpClient;
  const ssh = yield* SshClient;
  const client = baseClient.pipe(HttpClient.filterStatusOk);
  const url = (path: string) => `${config.addr}${path}`;

  // GET /v1/catalog/service/{name}
  const catalogService = Effect.fnUntraced(function* (name: string) {
    const req = HttpClientRequest.get(url(`/v1/catalog/service/${encodeURIComponent(name)}`));
    const res = yield* client.execute(req);
    return (yield* res.json) as ReadonlyArray<ConsulCatalogEntry>;
  });

  // Consul's catalog is replicated cluster-wide, so any agent can answer a
  // read (catalogService/resolveServiceHost/serviceIsPassing) -- but a PUT to
  // /v1/agent/service/register is agent-local: it attributes the service to
  // whichever node that agent is, not the node actually running it. Calling
  // it over the network from an operator's machine would (and did, in
  // testing) silently mis-register every service under the wrong node. Script
  // checks compound this: Consul only executes them when registered via the
  // agent's own loopback, by design (enable_local_script_checks), so a remote
  // PUT is rejected outright for any service using one. Running curl over SSH
  // on the target host itself is local by construction, so it satisfies both.
  const agentCurl = (
    host: string,
    method: "PUT",
    path: string,
    body?: string,
  ): Effect.Effect<void, SshError, never> => {
    const cmd = body
      ? `echo ${Buffer.from(body).toString("base64")} | base64 -d | curl -sf -X ${method} --data-binary @- http://127.0.0.1:8500${path}`
      : `curl -sf -X ${method} http://127.0.0.1:8500${path}`;
    return ssh.exec(host, cmd, SVC_USER).pipe(Effect.asVoid);
  };

  return {
    registerService: (definition: ConsulServiceDefinition, host: string) =>
      agentCurl(host, "PUT", "/v1/agent/service/register", JSON.stringify(definition)),

    deregisterService: (id: string, host: string) =>
      agentCurl(host, "PUT", `/v1/agent/service/deregister/${encodeURIComponent(id)}`),

    // GET /v1/catalog/service/{name}
    catalogService,

    // GET /v1/catalog/service/{name} (resolve the first catalog entry)
    resolveServiceHost: Effect.fnUntraced(function* (name: string) {
      const entries = yield* catalogService(name);
      const first = entries[0];
      if (!first) {
        return yield* new ConsulServiceNotFoundError({ service: name });
      }
      return first.ServiceAddress || first.Address;
    }),

    serviceIsPassing: Effect.fnUntraced(function* (name: string) {
      const req = HttpClientRequest.get(
        url(`/v1/health/service/${encodeURIComponent(name)}?passing=1`),
      );
      const res = yield* client.execute(req);
      const entries = (yield* res.json) as ReadonlyArray<ConsulHealthEntry>;
      return entries.length > 0;
    }),
  } satisfies ConsulClientShape;
});

// ---------------------------------------------------------------------------
// Layer (parameterized)
// ---------------------------------------------------------------------------

export const ConsulClientLive = (config: ConsulConfig) => Layer.effect(ConsulClient, make(config));
