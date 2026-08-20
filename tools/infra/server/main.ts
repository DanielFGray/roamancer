#!/usr/bin/env bun
import {
  HttpApiBuilder,
  HttpMiddleware,
  HttpServer,
} from "@effect/platform"
import { BunHttpServer, BunRuntime } from "@effect/platform-bun"
import * as FetchHttpClient from "@effect/platform/FetchHttpClient"
import { Effect, Layer, Logger, LogLevel, Redacted, Ref } from "effect"
import { timingSafeEqual } from "node:crypto"
import {
  InfraApi,
  Authorization,
  CurrentUser,
  DeployError,
  NotFoundError,
  Unauthorized,
} from "./api.ts"
import { WebhooksGroupLive } from "./webhook.ts"
import { SchedulerLive, BackupStatus, BackupStatusLive } from "./scheduler.ts"
import { DeployRunner } from "../src/services/DeployRunner.ts"
import { CaddyManager } from "../src/services/CaddyManager.ts"
import { SshClient } from "../src/services/SshClient.ts"
import { OpenBaoClient, OpenBaoClientLive } from "../src/services/OpenBaoClient.ts"
import { PasswordGenerator } from "../src/services/PasswordGenerator.ts"
import { GitManager } from "../src/services/GitManager.ts"
import {
  API_PORT,
  API_TOKEN,
  API_TOKEN_FILE,
  INFRA_AGENT_API_TOKEN_KEY,
  INFRA_CONFIG_DIR,
  INFRA_AGENT_SECRET_PATH,
  INFRA_AGENT_WEBHOOK_SECRET_KEY,
  OPENBAO_ADDR,
  OPENBAO_TOKEN,
  WEBHOOK_SECRET_FILE,
} from "../src/lib/config.ts"
import { writeFileSync, mkdirSync, chmodSync } from "node:fs"

// ---------------------------------------------------------------------------
// Stub response helper (status endpoint only)
// ---------------------------------------------------------------------------

const stub = (message: string) =>
  Effect.succeed({ status: "ok" as const, message })

const tokenEquals = (actual: string, expected: string) => {
  const actualBuf = Buffer.from(actual)
  const expectedBuf = Buffer.from(expected)
  return actualBuf.length === expectedBuf.length && timingSafeEqual(actualBuf, expectedBuf)
}

const apiToken = () => process.env["INFRA_API_TOKEN"] ?? API_TOKEN

const writeSecretFile = (path: string, value: string) => {
  mkdirSync(INFRA_CONFIG_DIR, { recursive: true })
  writeFileSync(path, `${value.trim()}\n`, { mode: 0o600 })
  chmodSync(path, 0o600)
}

// ---------------------------------------------------------------------------
// Auth middleware implementation
// ---------------------------------------------------------------------------

const AuthorizationLive = Layer.effect(
  Authorization,
  Effect.gen(function* () {
    if (!apiToken()) {
      yield* Effect.logError(
        "INFRA_API_TOKEN not set -- protected infra API endpoints will reject all requests",
      )
    }

    return Authorization.of({
      bearer: (token) =>
        Effect.gen(function* () {
          const raw = Redacted.value(token)

          const expected = apiToken()
          if (!expected) {
            return yield* new Unauthorized({
              message: "infra API disabled until INFRA_API_TOKEN is configured",
            })
          }

          if (!tokenEquals(raw, expected)) {
            return yield* new Unauthorized({ message: "invalid bearer token" })
          }

          return CurrentUser.of({ token: raw })
        }),
    })
  }),
)

// ---------------------------------------------------------------------------
// Group handlers
// ---------------------------------------------------------------------------

const ProjectsGroupLive = HttpApiBuilder.group(
  InfraApi,
  "projects",
  (handlers) =>
    handlers
      .handle("listProjects", () =>
        Effect.gen(function* () {
          const runner = yield* DeployRunner
          return yield* runner.listProjects()
        }),
      )
      .handle("getProject", ({ path }) =>
        Effect.gen(function* () {
          const runner = yield* DeployRunner
          const result = yield* runner.getStages(path.name)
          if (!result) {
            return yield* new NotFoundError({
              message: `project not found: ${path.name}`,
            })
          }
          return result
        }),
      )
      .handle("listStages", ({ path }) =>
        Effect.gen(function* () {
          const runner = yield* DeployRunner
          const result = yield* runner.getStages(path.name)
          if (!result) {
            return yield* new NotFoundError({
              message: `project not found: ${path.name}`,
            })
          }
          return result
        }),
      ),
)

const StatusGroupLive = HttpApiBuilder.group(
  InfraApi,
  "status",
  (handlers) =>
    handlers
      .handle("getStatus", () => stub("system status: healthy"))
      .handle("getBackups", () =>
        Effect.gen(function* () {
          const statusRef = yield* BackupStatus
          return yield* Ref.get(statusRef)
        }),
      )
      .handle("getRoutes", () =>
        Effect.gen(function* () {
          const caddy = yield* CaddyManager
          return yield* caddy.listRoutes()
        }).pipe(Effect.catchAll(() => Effect.succeed([]))),
      )
      .handle("syncRoutes", () =>
        Effect.gen(function* () {
          const caddy = yield* CaddyManager
          yield* caddy.sync()
          return { status: "ok" as const, message: "Caddy routes synced" }
        }).pipe(
          Effect.catchAll((err) =>
            Effect.succeed({ status: "error" as const, message: String(err) }),
          ),
        ),
      ),
)

const ActionsGroupLive = HttpApiBuilder.group(
  InfraApi,
  "actions",
  (handlers) =>
    handlers
      .handle("deploy", ({ payload }) =>
        Effect.gen(function* () {
          const runner = yield* DeployRunner
          return yield* runner.deploy({
            name: payload.name,
            ref: payload.ref,
            stage: payload.as,
            repo: payload.repo,
          })
        }).pipe(
          Effect.catchAll((err) =>
            new DeployError({ message: String(err) }),
          ),
        ),
      )
      .handle("promote", ({ payload }) =>
        Effect.gen(function* () {
          const runner = yield* DeployRunner
          return yield* runner.promote({
            name: payload.name,
            stage: payload.stage,
            ...(payload.force !== undefined ? { force: payload.force } : {}),
          })
        }).pipe(
          Effect.catchAll((err) =>
            new NotFoundError({ message: String(err) }),
          ),
        ),
      )
      .handle("rollback", ({ payload }) =>
        Effect.gen(function* () {
          const runner = yield* DeployRunner
          return yield* runner.rollback({ name: payload.name })
        }).pipe(
          Effect.catchAll((err) =>
            new NotFoundError({ message: String(err) }),
          ),
        ),
      )
      .handle("teardown", ({ payload }) =>
        Effect.gen(function* () {
          const runner = yield* DeployRunner
          return yield* runner.teardown({
            name: payload.name,
            stage: payload.stage,
          })
        }).pipe(
          Effect.catchAll((err) =>
            new NotFoundError({ message: String(err) }),
          ),
        ),
      ),
)

// ---------------------------------------------------------------------------
// Compose & serve
// ---------------------------------------------------------------------------

const InfraApiLive = HttpApiBuilder.api(InfraApi).pipe(
  Layer.provide(ProjectsGroupLive),
  Layer.provide(StatusGroupLive),
  Layer.provide(ActionsGroupLive),
  Layer.provide(WebhooksGroupLive),
  Layer.provide(AuthorizationLive),
)

// ---------------------------------------------------------------------------
// Service dependencies
// ---------------------------------------------------------------------------
// Dependency graph (same as CLI's src/main.ts):
//   Leaves: PasswordGenerator, SshClient, GitManager, OpenBaoClient
//   Derived: SecretResolver <- PasswordGenerator
//            DeployMeta <- StateDb
//   Composed: CaddyManager <- DeployMeta
//             HealthCheck <- SshClient
//             SystemdManager <- SshClient
//   Top: DeployRunner <- all of the above

const OpenBaoLive = OpenBaoClientLive({
  addr: OPENBAO_ADDR,
  token: OPENBAO_TOKEN,
}).pipe(Layer.provide(FetchHttpClient.layer))

const AgentSecretOverridesLive = Layer.effectDiscard(
  Effect.gen(function* () {
    if (!OPENBAO_TOKEN) {
      yield* Effect.logWarning(
        "OPENBAO_TOKEN not configured; infra agent cannot hydrate API/webhook secrets from OpenBao",
      )
      return
    }

    const bao = yield* OpenBaoClient
    const secrets = yield* bao.kvGet(INFRA_AGENT_SECRET_PATH).pipe(
      Effect.catchAll(() => Effect.succeed<Record<string, string>>({})),
    )

    const apiToken = secrets[INFRA_AGENT_API_TOKEN_KEY]
    if (apiToken && !process.env["INFRA_API_TOKEN"]) {
      process.env["INFRA_API_TOKEN"] = apiToken
      writeSecretFile(API_TOKEN_FILE, apiToken)
      yield* Effect.log("Loaded INFRA_API_TOKEN from OpenBao")
    }

    const webhookSecret = secrets[INFRA_AGENT_WEBHOOK_SECRET_KEY]
    if (webhookSecret && !process.env["INFRA_WEBHOOK_SECRET"]) {
      process.env["INFRA_WEBHOOK_SECRET"] = webhookSecret
      writeSecretFile(WEBHOOK_SECRET_FILE, webhookSecret)
      yield* Effect.log("Loaded INFRA_WEBHOOK_SECRET from OpenBao")
    }
  }),
).pipe(Layer.provide(OpenBaoLive))

const Leaves = Layer.mergeAll(
  PasswordGenerator.Default,
  SshClient.Default,
  GitManager.Default,
  OpenBaoLive,
)

const DeployRunnerLive = DeployRunner.Default.pipe(
  Layer.provideMerge(Leaves),
)

const CaddySyncLive = Layer.effectDiscard(
  Effect.gen(function* () {
    const caddy = yield* CaddyManager
    yield* Effect.log("Syncing Caddy routes on startup...")
    yield* caddy.sync()
  }).pipe(Effect.catchAll((err) =>
    Effect.log(`Caddy startup sync failed (will retry on next deploy): ${err}`),
  )),
).pipe(Layer.provide(CaddyManager.Default))

const ServiceDeps = Layer.mergeAll(
  DeployRunnerLive,
  BackupStatusLive,
  CaddySyncLive,
  CaddyManager.Default,
)

// ---------------------------------------------------------------------------
// Compose & launch
// ---------------------------------------------------------------------------

const HttpLive = HttpApiBuilder.serve(HttpMiddleware.logger).pipe(
  HttpServer.withLogAddress,
  Layer.provide(InfraApiLive),
  Layer.provide(BunHttpServer.layer({ port: API_PORT })),
)

const MainLive = Layer.mergeAll(HttpLive, SchedulerLive).pipe(
  Layer.provide(AgentSecretOverridesLive),
  Layer.provide(ServiceDeps),
  Layer.provide(Logger.minimumLogLevel(LogLevel.Info)),
)

Layer.launch(MainLive).pipe(BunRuntime.runMain)
