#!/usr/bin/env bun
import { Command } from "@effect/cli";
import { BunContext, BunRuntime } from "@effect/platform-bun";
import { Effect, Layer, Schema as S } from "effect";
import * as FileSystem from "@effect/platform/FileSystem";
import * as Path from "@effect/platform/Path";
import * as FetchHttpClient from "@effect/platform/FetchHttpClient";
import { vaultCommand } from "./commands/vault.ts";
import { backupCommand } from "./commands/backup.ts";
import { serviceCommand } from "./commands/service.ts";
import { hostCommand } from "./commands/host.ts";
import {
  doctorCommand,
  routesCommand,
  syncCommand,
  probeCommand,
  dnsCommand,
} from "./commands/diagnostics.ts";
import {
  deployCommand,
  promoteCommand,
  rollbackCommand,
  stagesCommand,
  teardownCommand,
  projectsCommand,
  statusCommand,
  backupsCommand,
  logsCommand,
  directCommand,
} from "./commands/remote.ts";
import { OpenBaoClientLive, type OpenBaoConfig } from "./services/OpenBaoClient.ts";
import { ConsulClientLive } from "./services/ConsulClient.ts";
import { PasswordGenerator } from "./services/PasswordGenerator.ts";
import { SecretResolver } from "./services/SecretResolver.ts";
import { SshClient } from "./services/SshClient.ts";
import { GitManager } from "./services/GitManager.ts";
import { DeployMeta } from "./services/DeployMeta.ts";
import { CaddyManager } from "./services/CaddyManager.ts";
import { HealthCheck } from "./services/HealthCheck.ts";
import { SystemdManager } from "./services/SystemdManager.ts";
import { InfraClient } from "./services/InfraClient.ts";
import { DeployRunner } from "./services/DeployRunner.ts";
import { CONSUL_ADDR, HOME_DIR, OPENBAO_ADDR, OPENBAO_TOKEN } from "./lib/config.ts";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const loadConfig = Effect.gen(function* () {
  if (OPENBAO_TOKEN) {
    return { addr: OPENBAO_ADDR, token: OPENBAO_TOKEN } satisfies OpenBaoConfig;
  }

  const path = yield* Path.Path;
  const fs = yield* FileSystem.FileSystem;
  const initPath = path.join(HOME_DIR, ".config", "infra", "vault-init.json");

  const exists = yield* fs.exists(initPath);
  if (exists) {
    const content = yield* fs.readFileString(initPath);
    const VaultInit = S.Struct({ root_token: S.optional(S.String) });
    const parsed = yield* S.decodeUnknown(S.parseJson(VaultInit))(content);
    if (parsed.root_token) {
      return { addr: OPENBAO_ADDR, token: parsed.root_token } satisfies OpenBaoConfig;
    }
  }

  return { addr: OPENBAO_ADDR } satisfies OpenBaoConfig;
}).pipe(Effect.orElseSucceed(() => ({ addr: OPENBAO_ADDR }) satisfies OpenBaoConfig));

// ---------------------------------------------------------------------------
// Layers
// ---------------------------------------------------------------------------

const OpenBaoLive = Layer.unwrapEffect(
  loadConfig.pipe(Effect.map((config) => OpenBaoClientLive(config))),
).pipe(Layer.provide(FetchHttpClient.layer));
const ConsulLive = ConsulClientLive({ addr: CONSUL_ADDR }).pipe(
  Layer.provide(FetchHttpClient.layer),
  Layer.provide(SshClient.Default),
);

// Dependency graph:
//   Level 0 (leaves)  : PasswordGenerator, SshClient, GitManager, OpenBaoClient, StateDb
//   Level 1 (derived) : SecretResolver <- PasswordGenerator
//                        DeployMeta <- StateDb
//   Level 2 (composed): CaddyManager <- DeployMeta
//                        HealthCheck <- SshClient
//                        SystemdManager <- SshClient

const Leaves = Layer.mergeAll(
  PasswordGenerator.Default,
  SshClient.Default,
  GitManager.Default,
  OpenBaoLive,
  ConsulLive,
);

const AppLayer = Layer.mergeAll(
  SecretResolver.Default,
  DeployMeta.Default,
  CaddyManager.Default,
  HealthCheck.Default,
  SystemdManager.Default,
  InfraClient.Default,
  DeployRunner.Default,
).pipe(Layer.provideMerge(Leaves));

// ---------------------------------------------------------------------------
// Root command
// ---------------------------------------------------------------------------

const infra = Command.make("infra").pipe(
  Command.withHandler(() => Effect.void),
  Command.withSubcommands([
    deployCommand,
    promoteCommand,
    rollbackCommand,
    stagesCommand,
    teardownCommand,
    projectsCommand,
    statusCommand,
    backupsCommand,
    logsCommand,
    vaultCommand,
    backupCommand,
    serviceCommand,
    hostCommand,
    doctorCommand,
    routesCommand,
    syncCommand,
    probeCommand,
    dnsCommand,
    directCommand,
  ]),
  Command.withDescription("Infrastructure management CLI"),
);

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

const cli = Command.run(infra, {
  name: "infra",
  version: "0.1.0",
});

const FullLayer = AppLayer.pipe(
  Layer.provideMerge(BunContext.layer),
  Layer.provideMerge(FetchHttpClient.layer),
);

cli(process.argv).pipe(Effect.provide(FullLayer), BunRuntime.runMain);
