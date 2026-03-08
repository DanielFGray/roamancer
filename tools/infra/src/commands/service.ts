import { Command, Args } from "@effect/cli"
import { Console, Effect, Schema as S } from "effect"
import * as FileSystem from "@effect/platform/FileSystem"
import * as Path from "@effect/platform/Path"
import { SshClient } from "../services/SshClient.ts"
import { OpenBaoClient } from "../services/OpenBaoClient.ts"
import { SecretResolver } from "../services/SecretResolver.ts"
import { parseEnvExample, formatEnv } from "../lib/env-parser.ts"
import { SVC_USER, REPO_ROOT } from "../lib/config.ts"

// ---------------------------------------------------------------------------
// Service definitions — infra services managed by this repo, not projects
// ---------------------------------------------------------------------------

interface InfraService {
  readonly name: string
  readonly host: string
  readonly composeDir: string   // local path to compose dir (relative to repo root)
  readonly remoteDir: string    // where compose files live on the target
}

const infraServices: ReadonlyArray<InfraService> = [
  {
    name: "infra",
    host: "cynic.dlab",
    composeDir: `${REPO_ROOT}/services/infra`,
    remoteDir: "/opt/services/infra",
  },
  {
    name: "signoz",
    host: "atheist.dlab",
    composeDir: `${REPO_ROOT}/services/signoz`,
    remoteDir: "/opt/services/signoz",
  },
]

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Provision secrets for an infra service: seed to vault if missing, return env */
const provisionServiceSecrets = (svc: InfraService) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const pathSvc = yield* Path.Path
    const bao = yield* OpenBaoClient
    const resolver = yield* SecretResolver

    const envPath = pathSvc.join(svc.composeDir, ".env.example")
    const exists = yield* fs.exists(envPath)
    if (!exists) return null

    const content = yield* fs.readFileString(envPath)
    const fields = parseEnvExample(content)
    if (fields.length === 0) return null

    // Try existing vault secrets
    const existing = yield* bao.kvGet(svc.name).pipe(
      Effect.catchAll(() => Effect.succeed(null)),
    )

    if (existing) {
      yield* Console.log("Secrets already seeded, using vault values")
      return existing
    }

    yield* Console.log("Seeding secrets to vault...")
    const resolved = yield* resolver.resolve(fields)
    yield* bao.kvPut(svc.name, resolved)
    return resolved
  })

class UnknownServiceError extends S.TaggedError<UnknownServiceError>()(
  "UnknownServiceError",
  { name: S.String, available: S.Array(S.String) },
) {
  override get message() {
    return `Unknown service: ${this.name}\nAvailable: ${this.available.join(", ")}`
  }
}

const findService = (name: string) =>
  Effect.fromNullable(infraServices.find((s) => s.name === name)).pipe(
    Effect.mapError(() => new UnknownServiceError({
      name,
      available: infraServices.map((s) => s.name),
    })),
  )

// ---------------------------------------------------------------------------
// Subcommands
// ---------------------------------------------------------------------------

const serviceNameArg = Args.text({ name: "name" }).pipe(
  Args.withDescription("Infrastructure service to manage (infra, signoz)"),
)

const serviceUp = Command.make("up", { name: serviceNameArg }).pipe(
  Command.withHandler(({ name }) =>
    Effect.gen(function* () {
      const ssh = yield* SshClient
      const svc = yield* findService(name)

      yield* Console.log(`Setting up ${svc.name} on ${svc.host}...`)
      yield* ssh.exec(svc.host, `mkdir -p ${svc.remoteDir}`, SVC_USER)

      yield* Console.log("Syncing compose files...")
      yield* ssh.rsync(`${svc.composeDir}/`, svc.remoteDir, svc.host, SVC_USER)

      // Provision secrets from .env.example if present
      const secrets = yield* provisionServiceSecrets(svc)
      if (secrets) {
        yield* Console.log("Writing .env to remote...")
        yield* ssh.writeFile(svc.host, `${svc.remoteDir}/.env`, formatEnv(secrets), {
          mode: "600",
          user: SVC_USER,
        })
      }

      yield* Console.log("Starting services...")
      yield* ssh.exec(svc.host, `cd ${svc.remoteDir} && podman-compose up -d`, SVC_USER)

      yield* Console.log(`${svc.name} is up on ${svc.host}`)
    }),
  ),
  Command.withDescription("Deploy and start an infrastructure service"),
)

const serviceDown = Command.make("down", { name: serviceNameArg }).pipe(
  Command.withHandler(({ name }) =>
    Effect.gen(function* () {
      const ssh = yield* SshClient
      const svc = yield* findService(name)

      yield* Console.log(`Stopping ${svc.name} on ${svc.host}...`)
      yield* ssh.exec(svc.host, `cd ${svc.remoteDir} && podman-compose down`, SVC_USER)
      yield* Console.log(`${svc.name} stopped`)
    }),
  ),
  Command.withDescription("Stop an infrastructure service"),
)

const serviceStatus = Command.make("status").pipe(
  Command.withHandler(() =>
    Effect.gen(function* () {
      const ssh = yield* SshClient

      yield* Effect.forEach(infraServices, (svc) =>
        Console.log(`${svc.name} (${svc.host}):`).pipe(
          Effect.flatMap(() =>
            ssh.exec(
              svc.host,
              `cd ${svc.remoteDir} && podman-compose ps 2>/dev/null || echo "  not deployed"`,
              SVC_USER,
            ).pipe(Effect.catchAll(() => Effect.succeed("  unreachable"))),
          ),
          Effect.tap((output) => Console.log(output)),
          Effect.tap(() => Console.log("")),
        ),
      )
    }),
  ),
  Command.withDescription("Show status of infrastructure services"),
)

const serviceList = Command.make("list").pipe(
  Command.withHandler(() =>
    Console.log("Infrastructure services:").pipe(
      Effect.tap(() =>
        Effect.forEach(infraServices, (svc) =>
          Console.log(`  ${svc.name} -> ${svc.host} (${svc.remoteDir})`),
        ),
      ),
    ),
  ),
  Command.withDescription("List available infrastructure services"),
)

// ---------------------------------------------------------------------------
// Group command
// ---------------------------------------------------------------------------

export const serviceCommand = Command.make("service").pipe(
  Command.withHandler(() => Effect.void),
  Command.withSubcommands([serviceUp, serviceDown, serviceStatus, serviceList]),
  Command.withDescription("Manage infrastructure services (postgres, valkey, signoz)"),
)
