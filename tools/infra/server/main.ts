#!/usr/bin/env bun
import { HttpApiBuilder, HttpMiddleware, HttpServer } from "@effect/platform";
import { BunContext, BunHttpServer, BunRuntime } from "@effect/platform-bun";
import * as FileSystem from "@effect/platform/FileSystem";
import * as FetchHttpClient from "@effect/platform/FetchHttpClient";
import { Effect, Layer, Logger, LogLevel, Redacted, Ref } from "effect";
import { timingSafeEqual } from "node:crypto";
import {
  InfraApi,
  Authorization,
  CurrentUser,
  DeployError,
  NotFoundError,
  Unauthorized,
} from "./api.ts";
import { OperationalReportService } from "../src/services/OperationalReport.ts";
import { WebhooksGroupLive } from "./webhook.ts";
import { AgentSecrets } from "./secrets.ts";
import { SchedulerLive, BackupStatus, BackupStatusLive } from "./scheduler.ts";
import { DeployRunner } from "../src/services/DeployRunner.ts";
import { CaddyManager } from "../src/services/CaddyManager.ts";
import { SshClient } from "../src/services/SshClient.ts";
import { OpenBaoClient, OpenBaoClientLive } from "../src/services/OpenBaoClient.ts";
import { PasswordGenerator } from "../src/services/PasswordGenerator.ts";
import { GitManager } from "../src/services/GitManager.ts";
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
  WEBHOOK_SECRET,
} from "../src/lib/config.ts";

// ---------------------------------------------------------------------------
// Stub response helper (status endpoint only)
// ---------------------------------------------------------------------------

const tokenEquals = (actual: string, expected: string) => {
  const actualBuf = Buffer.from(actual);
  const expectedBuf = Buffer.from(expected);
  return actualBuf.length === expectedBuf.length && timingSafeEqual(actualBuf, expectedBuf);
};

const writeSecretFile = Effect.fnUntraced(function* (path: string, value: string) {
  const fs = yield* FileSystem.FileSystem;
  yield* fs.makeDirectory(INFRA_CONFIG_DIR, { recursive: true, mode: 0o700 });
  yield* fs.writeFileString(path, `${value.trim()}\n`, { mode: 0o600 });
  yield* fs.chmod(path, 0o600);
});

// ---------------------------------------------------------------------------
// Auth middleware implementation
// ---------------------------------------------------------------------------

const AuthorizationLive = Layer.effect(
  Authorization,
  Effect.gen(function* () {
    const { apiToken } = yield* AgentSecrets;
    if (!apiToken) {
      yield* Effect.logError(
        "INFRA_API_TOKEN not set -- protected infra API endpoints will reject all requests",
      );
    }

    return Authorization.of({
      bearer: Effect.fnUntraced(function* (token) {
        const raw = Redacted.value(token);

        if (!apiToken) {
          return yield* new Unauthorized({
            message: "infra API disabled until INFRA_API_TOKEN is configured",
          });
        }

        if (!tokenEquals(raw, apiToken)) {
          return yield* new Unauthorized({ message: "invalid bearer token" });
        }

        return CurrentUser.of({ token: raw });
      }),
    });
  }),
);

// ---------------------------------------------------------------------------
// Group handlers
// ---------------------------------------------------------------------------

const ProjectsGroupLive = HttpApiBuilder.group(InfraApi, "projects", (handlers) =>
  handlers
    .handle(
      "listProjects",
      Effect.fnUntraced(function* () {
        const runner = yield* DeployRunner;
        return yield* runner.listProjects();
      }),
    )
    .handle(
      "getProject",
      Effect.fnUntraced(function* ({ path }) {
        const runner = yield* DeployRunner;
        const result = yield* runner.getStages(path.name);
        if (!result) {
          return yield* new NotFoundError({
            message: `project not found: ${path.name}`,
          });
        }
        return result;
      }),
    )
    .handle(
      "listStages",
      Effect.fnUntraced(function* ({ path }) {
        const runner = yield* DeployRunner;
        const result = yield* runner.getStages(path.name);
        if (!result) {
          return yield* new NotFoundError({
            message: `project not found: ${path.name}`,
          });
        }
        return result;
      }),
    ),
);

const StatusGroupLive = HttpApiBuilder.group(InfraApi, "status", (handlers) =>
  handlers
    .handle("getStatus", () =>
      Effect.gen(function* () {
        const report = yield* OperationalReportService;
        return yield* report();
      }),
    )
    .handle(
      "getBackups",
      Effect.fnUntraced(function* () {
        const statusRef = yield* BackupStatus;
        return yield* Ref.get(statusRef);
      }),
    )
    .handle("getRoutes", () =>
      Effect.gen(function* () {
        const caddy = yield* CaddyManager;
        return yield* caddy.listRoutes();
      }).pipe(Effect.orElseSucceed(() => [])),
    )
    .handle("syncRoutes", () =>
      Effect.gen(function* () {
        const caddy = yield* CaddyManager;
        yield* caddy.sync();
        return { status: "ok" as const, message: "Caddy routes synced" };
      }).pipe(
        Effect.orElseSucceed(() => ({ status: "error" as const, message: "Caddy sync failed" })),
      ),
    ),
);

const ActionsGroupLive = HttpApiBuilder.group(InfraApi, "actions", (handlers) =>
  handlers
    .handle("deploy", ({ payload }) =>
      Effect.gen(function* () {
        const runner = yield* DeployRunner;
        return yield* runner.deploy({
          name: payload.name,
          ref: payload.ref,
          stage: payload.as,
          repo: payload.repo,
        });
      }).pipe(Effect.catchAll((err) => new DeployError({ message: String(err) }))),
    )
    .handle("promote", ({ payload }) =>
      Effect.gen(function* () {
        const runner = yield* DeployRunner;
        return yield* runner.promote({
          name: payload.name,
          stage: payload.stage,
          ...(payload.force !== undefined ? { force: payload.force } : {}),
        });
      }).pipe(Effect.catchAll((err) => new NotFoundError({ message: String(err) }))),
    )
    .handle("rollback", ({ payload }) =>
      Effect.gen(function* () {
        const runner = yield* DeployRunner;
        return yield* runner.rollback({ name: payload.name });
      }).pipe(Effect.catchAll((err) => new NotFoundError({ message: String(err) }))),
    )
    .handle("teardown", ({ payload }) =>
      Effect.gen(function* () {
        const runner = yield* DeployRunner;
        return yield* runner.teardown({
          name: payload.name,
          stage: payload.stage,
        });
      }).pipe(Effect.catchAll((err) => new NotFoundError({ message: String(err) }))),
    ),
);

// ---------------------------------------------------------------------------
// Compose & serve
// ---------------------------------------------------------------------------

const InfraApiLive = HttpApiBuilder.api(InfraApi).pipe(
  Layer.provide(ProjectsGroupLive),
  Layer.provide(StatusGroupLive),
  Layer.provide(ActionsGroupLive),
  Layer.provide(WebhooksGroupLive),
  Layer.provide(AuthorizationLive),
);

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
}).pipe(Layer.provide(FetchHttpClient.layer));

const AgentSecretOverridesLive = Layer.effect(
  AgentSecrets,
  Effect.gen(function* () {
    if (!OPENBAO_TOKEN) {
      yield* Effect.logWarning(
        "OPENBAO_TOKEN not configured; infra agent cannot hydrate API/webhook secrets from OpenBao",
      );
      return { apiToken: API_TOKEN, webhookSecret: WEBHOOK_SECRET };
    }

    const bao = yield* OpenBaoClient;
    const secrets = yield* bao
      .kvGet(INFRA_AGENT_SECRET_PATH)
      .pipe(Effect.orElseSucceed(() => ({}) as Record<string, string>));

    const apiToken = secrets[INFRA_AGENT_API_TOKEN_KEY] ?? API_TOKEN;
    if (apiToken !== undefined && secrets[INFRA_AGENT_API_TOKEN_KEY]) {
      yield* writeSecretFile(API_TOKEN_FILE, apiToken);
      yield* Effect.log("Loaded INFRA_API_TOKEN from OpenBao");
    }

    const webhookSecret = secrets[INFRA_AGENT_WEBHOOK_SECRET_KEY] ?? WEBHOOK_SECRET;
    if (webhookSecret !== undefined && secrets[INFRA_AGENT_WEBHOOK_SECRET_KEY]) {
      yield* writeSecretFile(WEBHOOK_SECRET_FILE, webhookSecret);
      yield* Effect.log("Loaded INFRA_WEBHOOK_SECRET from OpenBao");
    }

    return { apiToken, webhookSecret };
  }),
).pipe(Layer.provide(OpenBaoLive), Layer.provide(BunContext.layer));

const Leaves = Layer.mergeAll(
  PasswordGenerator.Default,
  SshClient.Default,
  GitManager.Default,
  OpenBaoLive,
);

const DeployRunnerLive = DeployRunner.Default.pipe(Layer.provideMerge(Leaves));

const OperationalReportLive = OperationalReportService.Default.pipe(
  Layer.provideMerge(DeployRunnerLive),
  Layer.provideMerge(CaddyManager.Default),
  Layer.provide(BunContext.layer),
);

const CaddySyncLive = Layer.effectDiscard(
  Effect.gen(function* () {
    const caddy = yield* CaddyManager;
    yield* Effect.log("Syncing Caddy routes on startup...");
    yield* caddy.sync();
  }).pipe(
    Effect.catchAll((err) =>
      Effect.log(`Caddy startup sync failed (will retry on next deploy): ${err}`),
    ),
  ),
).pipe(Layer.provide(CaddyManager.Default));

const ServiceDeps = Layer.mergeAll(
  DeployRunnerLive,
  OperationalReportLive,
  BackupStatusLive,
  CaddySyncLive,
  CaddyManager.Default,
);

// ---------------------------------------------------------------------------
// Compose & launch
// ---------------------------------------------------------------------------

const HttpLive = HttpApiBuilder.serve(HttpMiddleware.logger).pipe(
  HttpServer.withLogAddress,
  Layer.provide(InfraApiLive),
  Layer.provide(BunHttpServer.layer({ port: API_PORT })),
);

const MainLive = Layer.mergeAll(HttpLive, SchedulerLive).pipe(
  Layer.provide(AgentSecretOverridesLive),
  Layer.provide(ServiceDeps),
  Layer.provide(Logger.minimumLogLevel(LogLevel.Info)),
);

Layer.launch(MainLive).pipe(BunRuntime.runMain);
