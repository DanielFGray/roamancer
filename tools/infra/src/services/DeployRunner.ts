import { Console, Duration, Effect, Schema as S } from "effect"

import { spawn } from "bun"
import { BunContext } from "@effect/platform-bun"
import * as FileSystem from "@effect/platform/FileSystem"
import * as Path from "@effect/platform/Path"
import { GitManager, sanitizeRef } from "./GitManager.ts"
import { DeployMeta, type StageInfo } from "./DeployMeta.ts"
import { CaddyManager, previewUrl } from "./CaddyManager.ts"
import { OpenBaoClient } from "./OpenBaoClient.ts"
import { SecretResolver } from "./SecretResolver.ts"
import { SshClient } from "./SshClient.ts"
import { SystemdManager } from "./SystemdManager.ts"
import { HealthCheck } from "./HealthCheck.ts"
import { parseEnvExample, formatEnv } from "../lib/env-parser.ts"
import { CADDY_HOST, RETIRE_GRACE_SECONDS, SVC_USER } from "../lib/config.ts"

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class BuildError extends S.TaggedError<BuildError>()("BuildError", {
  command: S.String,
  message: S.String,
}) {}

export class ProjectConfigError extends S.TaggedError<ProjectConfigError>()(
  "ProjectConfigError",
  { message: S.String },
) {}

export class StageNotFoundError extends S.TaggedError<StageNotFoundError>()(
  "StageNotFoundError",
  { name: S.String, stage: S.String },
) {
  override get message() {
    return `Stage "${this.stage}" not found for project: ${this.name}`
  }
}

export class NothingToRollbackError extends S.TaggedError<NothingToRollbackError>()(
  "NothingToRollbackError",
  { name: S.String },
) {
  override get message() {
    return `No previous promotion to rollback to for: ${this.name}`
  }
}

// ---------------------------------------------------------------------------
// Result types
// ---------------------------------------------------------------------------

export interface DeployResult {
  readonly name: string
  readonly stage: string
  readonly hash: string
  readonly type: string
  readonly previewUrl: string
}

export interface ProjectInfo {
  readonly name: string
  readonly stageCount: number
  readonly promoted: string | null
}

export interface StageListResult {
  readonly name: string
  readonly stages: ReadonlyArray<StageDetail>
  readonly production: string | null
}

export interface StageDetail {
  readonly stage: string
  readonly promoted: boolean
  readonly type: string
  readonly port: number | null
  readonly ref: string
  readonly hash: string
  readonly deployed_at: string
}

export interface RollbackResult {
  readonly name: string
  readonly stage: string
}

export interface TeardownResult {
  readonly name: string
  readonly stage: string
}

export interface PromoteResult {
  readonly name: string
  readonly stage: string
  readonly domain: string
}

// ---------------------------------------------------------------------------
// Project config from worktree's package.json
// ---------------------------------------------------------------------------

const PackageJson = S.Struct({
  scripts: S.optional(S.Record({ key: S.String, value: S.String })),
  infra: S.optional(S.Struct({
    domain: S.optional(S.String),
    dist: S.optional(S.String),
    host: S.optional(S.String),
    healthcheck: S.optional(S.Struct({
      path: S.optional(S.String),
      timeout: S.optional(S.Number),
    })),
  })),
})

interface ProjectConfig {
  readonly type: "static" | "service"
  readonly domain: string
  readonly dist: string
  readonly host: string
  readonly healthcheckPath: string
}

// ---------------------------------------------------------------------------
// Local build helper
// ---------------------------------------------------------------------------

const runLocal = (
  cwd: string,
  cmd: string,
  args: string[],
  env?: Record<string, string>,
) =>
  Effect.gen(function* () {
    const proc = spawn({
      cmd: [cmd, ...args],
      cwd,
      stdout: "inherit",
      stderr: "inherit",
      ...(env !== undefined ? { env: { ...process.env, ...env } } : {}),
    })

    const exitCode = yield* Effect.promise(() => proc.exited)
    if (exitCode !== 0) {
      return yield* new BuildError({
        command: `${cmd} ${args.join(" ")}`,
        message: `Exit code: ${exitCode}`,
      })
    }
  })

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export class DeployRunner extends Effect.Service<DeployRunner>()(
  "infra/DeployRunner",
  {
    effect: Effect.gen(function* () {
      const gitMgr = yield* GitManager
      const meta = yield* DeployMeta
      const caddy = yield* CaddyManager
      const ssh = yield* SshClient
      const systemd = yield* SystemdManager
      const healthCheck = yield* HealthCheck
      const bao = yield* OpenBaoClient
      const resolver = yield* SecretResolver
      const fs = yield* FileSystem.FileSystem
      const pathSvc = yield* Path.Path

      // Per-project mutex: prevents concurrent deploys to the same project
      // from corrupting state (e.g. two rapid webhook pushes)
      const projectLocks = new Map<string, Effect.Semaphore>()
      const withProjectLock = <A, E, R>(name: string, effect: Effect.Effect<A, E, R>) => {
        if (!projectLocks.has(name)) {
          projectLocks.set(name, Effect.unsafeMakeSemaphore(1))
        }
        return projectLocks.get(name)!.withPermits(1)(effect)
      }

      // Closures that capture pre-resolved services (no leaked R requirements)
      const readProjectConfig = (worktreePath: string, name: string) =>
        Effect.gen(function* () {
          const pkgPath = pathSvc.join(worktreePath, "package.json")
          const exists = yield* fs.exists(pkgPath)
          if (!exists) {
            return yield* new ProjectConfigError({
              message: `No package.json found in ${worktreePath}`,
            })
          }
          const content = yield* fs.readFileString(pkgPath)
          const pkg = yield* S.decodeUnknown(S.parseJson(PackageJson))(content)
          const hasDeployScript = pkg.scripts?.deploy !== undefined
          const hasBuildScript = pkg.scripts?.build !== undefined
          if (!hasDeployScript && !hasBuildScript) {
            return yield* new ProjectConfigError({
              message: `${name}: package.json needs a "build" or "deploy" script`,
            })
          }
          const infra = pkg.infra ?? {}
          return {
            type: hasDeployScript ? "service" : "static",
            domain: infra.domain ?? name,
            dist: infra.dist ?? "dist",
            host: infra.host ?? CADDY_HOST,
            healthcheckPath: infra.healthcheck?.path ?? "/health",
          } satisfies ProjectConfig
        })

      const provisionSecrets = (name: string, worktreePath: string) =>
        Effect.gen(function* () {
          const envPath = pathSvc.join(worktreePath, ".env.example")
          const exists = yield* fs.exists(envPath)
          if (!exists) return {} as Record<string, string>
          const content = yield* fs.readFileString(envPath)
          const fields = parseEnvExample(content)
          if (fields.length === 0) return {} as Record<string, string>
          const existing = yield* bao.kvGet(name).pipe(
            Effect.catchAll(() => Effect.succeed(null)),
          )
          if (existing) {
            yield* Console.log("  secrets: using vault values")
            return existing
          }
          yield* Console.log("  secrets: seeding to vault...")
          const resolved = yield* resolver.resolve(fields)
          yield* bao.kvPut(name, resolved)
          return resolved
        })

      // -------------------------------------------------------------------
      // deploy
      // -------------------------------------------------------------------

      const deploy = (params: {
        name: string
        ref?: string | undefined
        stage?: string | undefined
        repo?: string | undefined
      }) =>
        withProjectLock(params.name, Effect.gen(function* () {
          const { name, repo } = params

          yield* Console.log(`Deploying ${name}...`)

          // 1. Ensure bare repo + fetch
          yield* gitMgr.ensureRepo(name, repo)
          yield* gitMgr.fetch(name)

          // 2. Resolve ref and stage name
          const actualRef = !params.ref || params.ref === ""
            ? yield* gitMgr.defaultBranch(name)
            : params.ref
          const hash = yield* gitMgr.resolveRef(name, actualRef)
          const stage = params.stage ?? sanitizeRef(actualRef)

          yield* Console.log(`  ref: ${actualRef} (${hash})`)
          yield* Console.log(`  stage: ${stage}`)

          // 3. Create worktree
          const wt = yield* gitMgr.addWorktree(name, stage, actualRef)

          // 4. Read project config (clean up worktree on failure)
          const config = yield* readProjectConfig(wt, name).pipe(
            Effect.tapError(() =>
              gitMgr.removeWorktree(name, stage).pipe(Effect.catchAll(() => Effect.void)),
            ),
          )

          yield* Console.log(`  type: ${config.type}`)
          yield* Console.log(`  domain: ${config.domain}`)

          // 5. Provision secrets
          const secrets = yield* provisionSecrets(name, wt)

          // 6. Check existing stage
          const existing = yield* meta.getProject(name)
          const existingStage = existing?.stages[stage]
          const isZeroDowntime = existingStage?.type === "service" && existingStage.port !== null

          // 7. Allocate port for service
          const port = config.type === "service"
            ? (isZeroDowntime
                ? (yield* meta.allocatePort()) // always fresh port for zero-downtime
                : (existingStage?.port ?? (yield* meta.allocatePort())))
            : null
          const portIsNew = config.type === "service" && port !== null && port !== existingStage?.port

          // Cleanup helper for failed deploys
          const cleanup = Effect.all([
            gitMgr.removeWorktree(name, stage).pipe(Effect.catchAll(() => Effect.void)),
            portIsNew && port !== null
              ? meta.releasePort(port).pipe(Effect.catchAll(() => Effect.void))
              : Effect.void,
          ]).pipe(Effect.asVoid)

          // 8. Build and deploy
          const stageInfo = yield* Effect.gen(function* () {
            if (config.type === "static") {
              yield* Console.log("  installing deps...")
              yield* runLocal(wt, "bun", ["install", "--frozen-lockfile"])

              yield* Console.log("  building...")
              yield* runLocal(wt, "bun", ["run", "build"], secrets)

              const remoteDir = `/srv/www/${config.domain}/stages/${stage}`
              yield* Console.log(`  syncing -> ${config.host}:${remoteDir}`)
              yield* ssh.exec(config.host, `mkdir -p ${remoteDir}`, SVC_USER)
              yield* ssh.rsync(`${wt}/${config.dist}/`, remoteDir, config.host, SVC_USER)

              return {
                type: "static",
                ref: actualRef,
                hash,
                port: null,
                host: config.host,
                domain: config.domain,
                deployed_at: new Date().toISOString(),
                healthcheck_path: config.healthcheckPath,
              } as StageInfo
            }

            yield* Console.log(`  port: ${port}`)

            const unitName = `infra-${name}-${stage}`

            // ---------------------------------------------------------------
            // Zero-downtime deploy: old service keeps running while new starts
            // ---------------------------------------------------------------
            if (isZeroDowntime) {
              const oldPort = existingStage.port!
              const oldDir = `/srv/projects/${name}/stages/${stage}`
              const newDir = `/srv/projects/${name}/stages/${stage}.new`
              const newUnitName = `${unitName}-new`

              yield* Console.log("  zero-downtime deploy")
              yield* Console.log(`  old port: ${oldPort} -> new port: ${port}`)

              // a. Rsync to new directory
              yield* Console.log(`  syncing -> ${config.host}:${newDir}`)
              yield* ssh.exec(config.host, `mkdir -p ${newDir}`, SVC_USER)
              yield* ssh.rsync(`${wt}/`, newDir, config.host, SVC_USER)

              // b. Write .env with new port
              const envWithPort = { ...secrets, PORT: String(port) }
              yield* Console.log("  writing .env...")
              yield* ssh.exec(
                config.host,
                `cat > ${newDir}/.env << 'ENVEOF'\n${formatEnv(envWithPort)}\nENVEOF\nchmod 600 ${newDir}/.env`,
                SVC_USER,
              )

              // c. Install deps on remote
              yield* Console.log("  installing remote deps...")
              yield* ssh.exec(
                config.host,
                `cd ${newDir} && bun install --frozen-lockfile`,
                SVC_USER,
              )

              // d. Install + start new systemd unit
              yield* Console.log(`  installing systemd unit: ${newUnitName}`)
              yield* systemd.install(config.host, newUnitName, {
                description: `${name} (${stage}) [new]`,
                workingDirectory: newDir,
                execStart: `/usr/bin/env bun run start`,
                user: SVC_USER,
              })

              yield* Console.log("  starting new service...")
              yield* systemd.start(config.host, newUnitName)

              // e. Health check the new instance
              const newStageInfo: StageInfo = {
                type: "service",
                ref: actualRef,
                hash,
                port,
                host: config.host,
                domain: config.domain,
                deployed_at: new Date().toISOString(),
                healthcheck_path: config.healthcheckPath,
              }

              yield* Console.log("  checking health of new instance...")
              yield* healthCheck.check(newStageInfo, stage).pipe(
                Effect.catchAll((err) =>
                  // Unhealthy — rollback: stop new, clean up, keep old running
                  Effect.gen(function* () {
                    yield* Console.error(`  health check failed: ${err.reason}`)
                    yield* Console.log("  rolling back — stopping new instance...")
                    yield* systemd.remove(config.host, newUnitName).pipe(
                      Effect.catchAll(() => Effect.void),
                    )
                    yield* ssh.exec(config.host, `rm -rf ${newDir}`, SVC_USER).pipe(
                      Effect.catchAll(() => Effect.void),
                    )
                    return yield* new BuildError({
                      command: "health-check",
                      message: `New instance unhealthy, old service still running on port ${oldPort}. ${err.reason}`,
                    })
                  }),
                ),
              )

              yield* Console.log("  healthy — switching traffic")

              // f. Update metadata to new port, sync Caddy
              const base = existing ?? { repo: name, promoted: null, promoted_previous: null, stages: {} }
              yield* meta.saveProject(name, {
                ...base,
                stages: { ...base.stages, [stage]: newStageInfo },
              })

              yield* Console.log("  syncing routes...")
              yield* caddy.sync()

              // Stop old service
              yield* Console.log("  stopping old service...")
              yield* systemd.stop(config.host, unitName).pipe(
                Effect.catchAll(() => Effect.void),
              )

              // Grace period for in-flight requests to drain
              yield* Console.log(`  grace period: ${RETIRE_GRACE_SECONDS}s`)
              yield* Effect.sleep(Duration.seconds(RETIRE_GRACE_SECONDS))

              // Cleanup: remove old unit + old directory, rename new to final
              yield* Console.log("  cleaning up old deployment...")
              yield* systemd.remove(config.host, unitName).pipe(
                Effect.catchAll(() => Effect.void),
              )
              yield* ssh.exec(config.host, `rm -rf ${oldDir}`, SVC_USER).pipe(
                Effect.catchAll(() => Effect.void),
              )

              // Rename new directory -> final, reinstall systemd unit at final name
              yield* ssh.exec(config.host, `mv ${newDir} ${oldDir}`, SVC_USER)
              yield* systemd.remove(config.host, newUnitName).pipe(
                Effect.catchAll(() => Effect.void),
              )
              yield* systemd.install(config.host, unitName, {
                description: `${name} (${stage})`,
                workingDirectory: oldDir,
                execStart: `/usr/bin/env bun run start`,
                user: SVC_USER,
              })
              yield* systemd.start(config.host, unitName)

              return newStageInfo
            }

            // ---------------------------------------------------------------
            // Fresh deploy (no existing service)
            // ---------------------------------------------------------------
            const remoteDir = `/srv/projects/${name}/stages/${stage}`

            // Rsync source (no local install — remote handles its own deps)
            yield* Console.log(`  syncing -> ${config.host}:${remoteDir}`)
            yield* ssh.exec(config.host, `mkdir -p ${remoteDir}`, SVC_USER)
            yield* ssh.rsync(`${wt}/`, remoteDir, config.host, SVC_USER)

            // Write .env AFTER rsync (rsync --delete would clobber it)
            const envWithPort = { ...secrets, PORT: String(port) }
            yield* Console.log("  writing .env...")
            yield* ssh.exec(
              config.host,
              `cat > ${remoteDir}/.env << 'ENVEOF'\n${formatEnv(envWithPort)}\nENVEOF\nchmod 600 ${remoteDir}/.env`,
              SVC_USER,
            )

            // Install deps on remote
            yield* Console.log("  installing remote deps...")
            yield* ssh.exec(
              config.host,
              `cd ${remoteDir} && bun install --frozen-lockfile`,
              SVC_USER,
            )

            // Install + start systemd unit
            yield* Console.log(`  installing systemd unit: ${unitName}`)
            yield* systemd.install(config.host, unitName, {
              description: `${name} (${stage})`,
              workingDirectory: remoteDir,
              execStart: `/usr/bin/env bun run start`,
              user: SVC_USER,
            })

            yield* Console.log("  starting service...")
            yield* systemd.start(config.host, unitName)

            return {
              type: "service",
              ref: actualRef,
              hash,
              port,
              host: config.host,
              domain: config.domain,
              deployed_at: new Date().toISOString(),
              healthcheck_path: config.healthcheckPath,
            } as StageInfo
          }).pipe(Effect.onError(() => cleanup))

          // 9. Save metadata + sync routes (skip if zero-downtime already handled it)
          if (!isZeroDowntime) {
            const base = existing ?? { repo: name, promoted: null, promoted_previous: null, stages: {} }
            yield* meta.saveProject(name, {
              ...base,
              stages: { ...base.stages, [stage]: stageInfo },
            })

            yield* Console.log("  syncing routes...")
            yield* caddy.sync()
          }

          return {
            name,
            stage,
            hash,
            type: stageInfo.type,
            previewUrl: previewUrl(stage, config.domain),
          } satisfies DeployResult
        }))

      // -------------------------------------------------------------------
      // promote
      // -------------------------------------------------------------------

      const promote = (params: {
        name: string
        stage: string
        force?: boolean
      }) =>
        withProjectLock(params.name, Effect.gen(function* () {
          const { name, stage, force } = params

          const project = yield* meta.getProject(name)
          if (!project || Object.keys(project.stages).length === 0) {
            return yield* new StageNotFoundError({ name, stage })
          }

          const stageInfo = project.stages[stage]
          if (!stageInfo) {
            return yield* new StageNotFoundError({ name, stage })
          }

          // Health check before promoting
          if (!force) {
            yield* Console.log(`  checking health of ${stage}...`)
            yield* healthCheck.check(stageInfo, stage).pipe(
              Effect.tapError((err) =>
                Console.error(`Health check failed: ${err.reason}\nUse --force to skip.`),
              ),
            )
            yield* Console.log("  healthy")
          } else {
            yield* Console.log("  skipping health check (--force)")
          }

          yield* meta.saveProject(name, {
            ...project,
            promoted: stage,
            promoted_previous: project.promoted,
          })

          yield* caddy.sync()

          return {
            name,
            stage,
            domain: stageInfo.domain,
          } satisfies PromoteResult
        }))

      // -------------------------------------------------------------------
      // rollback
      // -------------------------------------------------------------------

      const rollback = (params: {
        name: string
      }) =>
        withProjectLock(params.name, Effect.gen(function* () {
          const { name } = params

          const project = yield* meta.getProject(name)
          if (!project) {
            return yield* new NothingToRollbackError({ name })
          }

          if (!project.promoted_previous) {
            return yield* new NothingToRollbackError({ name })
          }

          const prevStage = project.promoted_previous
          if (!project.stages[prevStage]) {
            return yield* new StageNotFoundError({ name, stage: prevStage })
          }

          yield* meta.saveProject(name, {
            ...project,
            promoted: prevStage,
            promoted_previous: project.promoted,
          })

          yield* caddy.sync()

          return { name, stage: prevStage } satisfies RollbackResult
        }))

      // -------------------------------------------------------------------
      // teardown
      // -------------------------------------------------------------------

      const teardown = (params: {
        name: string
        stage: string
      }) =>
        withProjectLock(params.name, Effect.gen(function* () {
          const { name, stage } = params

          const project = yield* meta.getProject(name)
          if (!project || !project.stages[stage]) {
            return yield* new StageNotFoundError({ name, stage })
          }

          const info = project.stages[stage]!

          if (info.type === "service") {
            const unitName = `infra-${name}-${stage}`
            yield* Console.log("  removing systemd unit...")
            yield* systemd.remove(info.host, unitName).pipe(
              Effect.catchAll(() => Effect.void),
            )

            yield* Console.log("  removing project files...")
            yield* ssh.exec(
              info.host,
              `rm -rf /srv/projects/${name}/stages/${stage}`,
              SVC_USER,
            ).pipe(Effect.catchAll(() => Effect.void))

            if (info.port !== null) {
              yield* meta.releasePort(info.port)
            }
          } else {
            yield* Console.log("  removing static files...")
            yield* ssh.exec(
              info.host,
              `rm -rf /srv/www/${info.domain}/stages/${stage}`,
              SVC_USER,
            ).pipe(Effect.catchAll(() => Effect.void))
          }

          // Remove worktree
          yield* Console.log("  removing worktree...")
          yield* gitMgr.removeWorktree(name, stage).pipe(Effect.catchAll(() => Effect.void))

          // Update metadata
          const remainingStages = Object.fromEntries(
            Object.entries(project.stages).filter(([key]) => key !== stage),
          )
          const promoted = project.promoted === stage ? null : project.promoted
          const promotedPrevious = project.promoted_previous === stage ? null : project.promoted_previous

          yield* meta.saveProject(name, {
            ...project,
            promoted,
            promoted_previous: promotedPrevious,
            stages: remainingStages,
          })

          yield* caddy.sync()

          return { name, stage } satisfies TeardownResult
        }))

      // -------------------------------------------------------------------
      // listProjects
      // -------------------------------------------------------------------

      const listProjects = (): Effect.Effect<ReadonlyArray<ProjectInfo>> =>
        Effect.gen(function* () {
          const names = yield* meta.listProjects()
          return yield* Effect.forEach(names, (name) =>
            Effect.gen(function* () {
              const project = yield* meta.getProject(name)
              return {
                name,
                stageCount: project ? Object.keys(project.stages).length : 0,
                promoted: project?.promoted ?? null,
              } satisfies ProjectInfo
            }),
          )
        })

      // -------------------------------------------------------------------
      // getStages
      // -------------------------------------------------------------------

      const getStages = (name: string): Effect.Effect<StageListResult | null> =>
        Effect.gen(function* () {
          const project = yield* meta.getProject(name)
          if (!project || Object.keys(project.stages).length === 0) {
            return null
          }

          const stages = Object.entries(project.stages).map(([stage, info]) => ({
            stage,
            promoted: project.promoted === stage,
            type: info.type,
            port: info.port,
            ref: info.ref,
            hash: info.hash,
            deployed_at: info.deployed_at,
          } satisfies StageDetail))

          return {
            name,
            stages,
            production: project.promoted
              ? (project.stages[project.promoted]?.domain ?? null)
              : null,
          } satisfies StageListResult
        })

      return { deploy, promote, rollback, teardown, listProjects, getStages }
    }),
    dependencies: [
      GitManager.Default,
      DeployMeta.Default,
      CaddyManager.Default,
      SecretResolver.Default,
      SshClient.Default,
      SystemdManager.Default,
      HealthCheck.Default,
      BunContext.layer,
    ],
  },
) {}
