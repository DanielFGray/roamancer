import { Effect, Context, Layer, pipe } from "effect"
import * as HttpClient from "@effect/platform/HttpClient"
import * as HttpClientRequest from "@effect/platform/HttpClientRequest"
import * as HttpClientError from "@effect/platform/HttpClientError"
import * as HttpBody from "@effect/platform/HttpBody"
import type { ParseError } from "effect/ParseResult"

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface OpenBaoConfig {
  readonly addr: string
  readonly token?: string | undefined
}

// ---------------------------------------------------------------------------
// Response types
// ---------------------------------------------------------------------------

export interface InitResult {
  readonly unsealKeys: ReadonlyArray<string>
  readonly rootToken: string
}

// ---------------------------------------------------------------------------
// Error type
// ---------------------------------------------------------------------------

export type OpenBaoError = HttpClientError.HttpClientError | HttpBody.HttpBodyError | ParseError

// ---------------------------------------------------------------------------
// Service (parameterized — uses Context.Tag, not Effect.Service)
//
// Effect.Service doesn't support parameterized construction, so we use
// Context.Tag and provide the Layer via OpenBaoClientLive(config).
// ---------------------------------------------------------------------------

export interface OpenBaoClientShape {
  readonly init: () => Effect.Effect<InitResult, OpenBaoError>
  readonly unseal: (key: string) => Effect.Effect<void, OpenBaoError>
  readonly enableSecretsEngine: (path: string, type: string) => Effect.Effect<void, OpenBaoError>
  readonly kvPut: (path: string, data: Record<string, string>, mount?: string) => Effect.Effect<void, OpenBaoError>
  readonly kvGet: (path: string, mount?: string) => Effect.Effect<Record<string, string>, OpenBaoError>
  readonly kvList: (path: string, mount?: string) => Effect.Effect<ReadonlyArray<string>, OpenBaoError>
  readonly createPolicy: (name: string, rules: string) => Effect.Effect<void, OpenBaoError>
  readonly write: (path: string, data: Record<string, unknown>) => Effect.Effect<unknown, OpenBaoError>
  readonly sealStatus: () => Effect.Effect<{
    readonly sealed: boolean
    readonly initialized: boolean
  }, OpenBaoError>
}

export class OpenBaoClient extends Context.Tag("infra/OpenBaoClient")<
  OpenBaoClient,
  OpenBaoClientShape
>() {}

// ---------------------------------------------------------------------------
// Parameterized construction
// ---------------------------------------------------------------------------

export const make = (
  config: OpenBaoConfig,
): Effect.Effect<OpenBaoClientShape, never, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const baseClient = yield* HttpClient.HttpClient

    const client = baseClient.pipe(
      HttpClient.mapRequest((req) => {
        const withHeaders = config.token
          ? HttpClientRequest.setHeader(req, "X-Vault-Token", config.token)
          : req
        return withHeaders
      }),
    )

    const url = (path: string) => `${config.addr}${path}`

    return {
      // PUT /v1/sys/init
      init: () =>
        Effect.gen(function* () {
          const req = yield* pipe(
            HttpClientRequest.put(url("/v1/sys/init")),
            HttpClientRequest.bodyJson({
              secret_shares: 1,
              secret_threshold: 1,
            }),
          )
          const res = yield* client.execute(req)
          const body = (yield* res.json) as {
            keys_base64: ReadonlyArray<string>
            root_token: string
          }
          return {
            unsealKeys: body.keys_base64,
            rootToken: body.root_token,
          } satisfies InitResult
        }),

      // PUT /v1/sys/unseal
      unseal: (key) =>
        Effect.gen(function* () {
          const req = yield* pipe(
            HttpClientRequest.put(url("/v1/sys/unseal")),
            HttpClientRequest.bodyJson({ key }),
          )
          yield* client.execute(req)
        }),

      // POST /v1/sys/mounts/{path}
      enableSecretsEngine: (mountPath, type) =>
        Effect.gen(function* () {
          const req = yield* pipe(
            HttpClientRequest.post(url(`/v1/sys/mounts/${mountPath}`)),
            HttpClientRequest.bodyJson({ type }),
          )
          yield* client.execute(req)
        }),

      // PUT /v1/{mount}/data/{path}  (kv-v2)
      kvPut: (kvPath, data, mount = "secret") =>
        Effect.gen(function* () {
          const req = yield* pipe(
            HttpClientRequest.put(url(`/v1/${mount}/data/${kvPath}`)),
            HttpClientRequest.bodyJson({ data }),
          )
          yield* client.execute(req)
        }),

      // GET /v1/{mount}/data/{path}  (kv-v2)
      kvGet: (kvPath, mount = "secret") =>
        Effect.gen(function* () {
          const req = HttpClientRequest.get(url(`/v1/${mount}/data/${kvPath}`))
          const res = yield* client.execute(req)
          const body = (yield* res.json) as {
            data: { data: Record<string, string> }
          }
          return body.data.data
        }),

      // PUT /v1/sys/policies/acl/{name}
      createPolicy: (name, rules) =>
        Effect.gen(function* () {
          const req = yield* pipe(
            HttpClientRequest.put(url(`/v1/sys/policies/acl/${name}`)),
            HttpClientRequest.bodyJson({ policy: rules }),
          )
          yield* client.execute(req)
        }),

      // GET /v1/{mount}/metadata/{path}?list=true  (kv-v2 list)
      kvList: (kvPath, mount = "secret") =>
        Effect.gen(function* () {
          const req = HttpClientRequest.get(url(`/v1/${mount}/metadata/${kvPath}?list=true`))
          const res = yield* client.execute(req)
          const body = (yield* res.json) as {
            data: { keys: ReadonlyArray<string> }
          }
          return body.data.keys
        }),

      // PUT /v1/{path}  (generic write)
      write: (writePath, data) =>
        Effect.gen(function* () {
          const req = yield* pipe(
            HttpClientRequest.put(url(`/v1/${writePath}`)),
            HttpClientRequest.bodyJson(data),
          )
          const res = yield* client.execute(req)
          return (yield* res.json) as unknown
        }),

      // GET /v1/sys/seal-status
      sealStatus: () =>
        Effect.gen(function* () {
          const req = HttpClientRequest.get(url("/v1/sys/seal-status"))
          const res = yield* client.execute(req)
          const body = (yield* res.json) as {
            sealed: boolean
            initialized: boolean
          }
          return { sealed: body.sealed, initialized: body.initialized }
        }),
    }
  })

// ---------------------------------------------------------------------------
// Layer (parameterized)
// ---------------------------------------------------------------------------

export const OpenBaoClientLive = (config: OpenBaoConfig) =>
  Layer.effect(OpenBaoClient, make(config))
