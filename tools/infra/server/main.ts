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
import { SshClient } from "../src/services/SshClient.ts"
import { OpenBaoClientLive } from "../src/services/OpenBaoClient.ts"
import { PasswordGenerator } from "../src/services/PasswordGenerator.ts"
import { GitManager } from "../src/services/GitManager.ts"
import { API_PORT, API_TOKEN, OPENBAO_ADDR } from "../src/lib/config.ts"

// ---------------------------------------------------------------------------
// Stub response helper (status endpoint only)
// ---------------------------------------------------------------------------

const stub = (message: string) =>
  Effect.succeed({ status: "ok" as const, message })

// ---------------------------------------------------------------------------
// Auth middleware implementation
// ---------------------------------------------------------------------------

const AuthorizationLive = Layer.effect(
  Authorization,
  Effect.gen(function* () {
    if (!API_TOKEN) {
      yield* Effect.logWarning(
        "INFRA_API_TOKEN not set -- running in dev mode (all requests allowed)",
      )
    }

    return Authorization.of({
      bearer: (token) =>
        Effect.gen(function* () {
          const raw = Redacted.value(token)

          // dev mode: no token configured, allow everything
          if (!API_TOKEN) {
            return CurrentUser.of({ token: raw })
          }

          const rawBuf = Buffer.from(raw)
          const expectedBuf = Buffer.from(API_TOKEN)

          if (rawBuf.length !== expectedBuf.length || !timingSafeEqual(rawBuf, expectedBuf)) {
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
  token: process.env["OPENBAO_TOKEN"],
}).pipe(Layer.provide(FetchHttpClient.layer))

const Leaves = Layer.mergeAll(
  PasswordGenerator.Default,
  SshClient.Default,
  GitManager.Default,
  OpenBaoLive,
)

const DeployRunnerLive = DeployRunner.Default.pipe(
  Layer.provideMerge(Leaves),
)

const ServiceDeps = Layer.mergeAll(
  DeployRunnerLive,
  BackupStatusLive,
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
  Layer.provide(ServiceDeps),
  Layer.provide(Logger.minimumLogLevel(LogLevel.Info)),
)

Layer.launch(MainLive).pipe(BunRuntime.runMain)
