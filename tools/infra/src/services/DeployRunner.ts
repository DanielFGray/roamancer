import { Console, DateTime, Duration, Effect, Schema as S } from "effect";

import { spawn } from "bun";
import { BunContext } from "@effect/platform-bun";
import * as FileSystem from "@effect/platform/FileSystem";
import * as Path from "@effect/platform/Path";
import { GitManager, sanitizeRef } from "./GitManager.ts";
import { DeployMeta, type StageInfo } from "./DeployMeta.ts";
import { CaddyManager } from "./CaddyManager.ts";
import { HealthCheck } from "./HealthCheck.ts";
import { DeploymentComponents } from "./DeploymentComponents.ts";
import { PromotionService, StageNotFoundError } from "./PromotionService.ts";
import {
  CADDY_HOST,
  DEPLOYMENT_ROOTS,
  ENVIRONMENT,
  HOME_DIR,
  RETIRE_GRACE_SECONDS,
} from "../lib/config.ts";
import { deploymentNames, deploymentPaths, previewUrl } from "../lib/deployment.ts";

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class BuildError extends S.TaggedError<BuildError>()("BuildError", {
  command: S.String,
  message: S.String,
}) {}

export class ProjectConfigError extends S.TaggedError<ProjectConfigError>()("ProjectConfigError", {
  message: S.String,
}) {}

// ---------------------------------------------------------------------------
// Result types
// ---------------------------------------------------------------------------

export interface DeployResult {
  readonly name: string;
  readonly stage: string;
  readonly hash: string;
  readonly type: string;
  readonly previewUrl: string;
  readonly autoPromote: string | undefined;
}

export interface ProjectInfo {
  readonly name: string;
  readonly stageCount: number;
  readonly promoted: string | null;
}

export interface StageListResult {
  readonly name: string;
  readonly stages: ReadonlyArray<StageDetail>;
  readonly production: string | null;
}

export interface StageDetail {
  readonly stage: string;
  readonly promoted: boolean;
  readonly type: string;
  readonly port: number | null;
  readonly domain: string;
  readonly ref: string;
  readonly hash: string;
  readonly deployed_at: string;
  readonly previewUrl: string;
}

export interface TeardownResult {
  readonly name: string;
  readonly stage: string;
}

// ---------------------------------------------------------------------------
// Project config from worktree's package.json
// ---------------------------------------------------------------------------

const PackageJson = S.Struct({
  scripts: S.optional(S.Record({ key: S.String, value: S.String })),
  infra: S.optional(
    S.Struct({
      domain: S.optional(S.String),
      dist: S.optional(S.String),
      host: S.optional(S.String),
      autoPromote: S.optional(S.String),
      healthcheck: S.optional(
        S.Struct({
          path: S.optional(S.String),
          timeout: S.optional(S.Number),
        }),
      ),
    }),
  ),
});

interface ProjectConfig {
  readonly type: "static" | "service";
  readonly domain: string;
  readonly dist: string;
  readonly host: string;
  readonly healthcheckPath: string;
  readonly autoPromote: string | undefined;
}

// ---------------------------------------------------------------------------
// Local build helper
// ---------------------------------------------------------------------------

const BUN_PATH = `${HOME_DIR}/.bun/bin`;

const runLocal = Effect.fnUntraced(function* (
  cwd: string,
  cmd: string,
  args: string[],
  env?: Record<string, string>,
) {
  const baseEnv = { ...ENVIRONMENT, PATH: `${BUN_PATH}:${ENVIRONMENT.PATH ?? ""}` };
  const proc = spawn({
    cmd: [cmd, ...args],
    cwd,
    stdout: "inherit",
    stderr: "inherit",
    env: { ...baseEnv, ...env },
  });

  const exitCode = yield* Effect.promise(() => proc.exited);
  if (exitCode !== 0) {
    return yield* new BuildError({
      command: `${cmd} ${args.join(" ")}`,
      message: `Exit code: ${exitCode}`,
    });
  }
});

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export const makeDeployRunner = Effect.gen(function* () {
  const gitMgr = yield* GitManager;
  const meta = yield* DeployMeta;
  const caddy = yield* CaddyManager;
  const components = yield* DeploymentComponents;
  const healthCheck = yield* HealthCheck;
  const promotion = yield* PromotionService;
  const fs = yield* FileSystem.FileSystem;
  const pathSvc = yield* Path.Path;

  // Per-project mutex: prevents concurrent deploys to the same project
  // from corrupting state (e.g. two rapid webhook pushes)
  const projectLocks = new Map<string, Effect.Semaphore>();
  const withProjectLock = <A, E, R>(name: string, effect: Effect.Effect<A, E, R>) => {
    if (!projectLocks.has(name)) {
      projectLocks.set(name, Effect.unsafeMakeSemaphore(1));
    }
    return projectLocks.get(name)!.withPermits(1)(effect);
  };

  // Closures that capture pre-resolved services (no leaked R requirements)
  const readProjectConfig = Effect.fnUntraced(function* (worktreePath: string, name: string) {
    const pkgPath = pathSvc.join(worktreePath, "package.json");
    const exists = yield* fs.exists(pkgPath);
    if (!exists) {
      return yield* new ProjectConfigError({
        message: `No package.json found in ${worktreePath}`,
      });
    }
    const content = yield* fs.readFileString(pkgPath);
    const pkg = yield* S.decodeUnknown(S.parseJson(PackageJson))(content);
    const hasDeployScript = pkg.scripts?.deploy !== undefined;
    const hasBuildScript = pkg.scripts?.build !== undefined;
    if (!hasDeployScript && !hasBuildScript) {
      return yield* new ProjectConfigError({
        message: `${name}: package.json needs a "build" or "deploy" script`,
      });
    }
    const infra = pkg.infra ?? {};
    return {
      type: hasDeployScript ? "service" : "static",
      domain: infra.domain ?? name,
      dist: infra.dist ?? "dist",
      host: infra.host ?? CADDY_HOST,
      healthcheckPath: infra.healthcheck?.path ?? "/health",
      autoPromote: infra.autoPromote,
    } satisfies ProjectConfig;
  });

  // -------------------------------------------------------------------
  // deploy
  // -------------------------------------------------------------------

  const deploy = (params: {
    name: string;
    ref?: string | undefined;
    stage?: string | undefined;
    repo?: string | undefined;
  }) =>
    withProjectLock(
      params.name,
      Effect.gen(function* () {
        const { name, repo } = params;

        yield* Console.log(`Deploying ${name}...`);

        // 1. Ensure bare repo + fetch
        yield* gitMgr.repository.ensure(name, repo);
        yield* gitMgr.repository.fetch(name);

        // 2. Resolve ref and stage name
        const actualRef =
          !params.ref || params.ref === ""
            ? yield* gitMgr.repository.defaultBranch(name)
            : params.ref;
        const hash = yield* gitMgr.repository.resolveRef(name, actualRef);
        const stage = params.stage ?? sanitizeRef(actualRef);

        yield* Console.log(`  ref: ${actualRef} (${hash})`);
        yield* Console.log(`  stage: ${stage}`);

        // 3. Create worktree
        const wt = yield* gitMgr.worktrees.add(name, stage, actualRef);

        const cleanupWorktree = gitMgr.worktrees.remove(name, stage).pipe(
          Effect.catchAll(() => Effect.void),
          Effect.asVoid,
        );

        // Preparation owns only the worktree. Artifact cleanup starts later, after its owner exists.
        const prepared = yield* Effect.gen(function* () {
          const config = yield* readProjectConfig(wt, name);

          yield* Console.log(`  type: ${config.type}`);
          yield* Console.log(`  domain: ${config.domain}`);

          const secrets = yield* components.secrets.resolve(name, wt);

          const existing = yield* meta.getProject(name);
          const existingStage = existing?.stages[stage];
          const isZeroDowntime = existingStage?.type === "service" && existingStage.port !== null;

          const port =
            config.type === "service"
              ? isZeroDowntime
                ? yield* meta.allocatePort() // always fresh port for zero-downtime
                : (existingStage?.port ?? (yield* meta.allocatePort()))
              : null;

          return { config, secrets, existing, existingStage, isZeroDowntime, port };
        }).pipe(Effect.onError(() => cleanupWorktree));

        const { config, secrets, existing, existingStage, isZeroDowntime, port } = prepared;

        // Persistent cleanup is explicit and only removes paths this attempt owns.
        const cleanup = Effect.gen(function* () {
          yield* cleanupWorktree;

          if (config.type === "static") {
            if (!existingStage) {
              yield* components.staticArtifacts
                .remove({ stage, domain: config.domain, host: config.host })
                .pipe(Effect.catchAll(() => Effect.void));
            }
            return;
          }

          const target = existingStage ? null : "final";
          if (target) {
            yield* components.serviceInstances
              .remove({ name, stage, host: config.host, target })
              .pipe(Effect.catchAll(() => Effect.void));
            yield* components.serviceArtifacts
              .remove({ name, stage, host: config.host, target })
              .pipe(Effect.catchAll(() => Effect.void));
          }
        }).pipe(Effect.asVoid);

        const cleanupCandidate = Effect.gen(function* () {
          yield* cleanupWorktree;
          yield* components.serviceInstances
            .remove({ name, stage, host: config.host, target: "candidate" })
            .pipe(Effect.catchAll(() => Effect.void));
          yield* components.serviceArtifacts
            .remove({ name, stage, host: config.host, target: "candidate" })
            .pipe(Effect.catchAll(() => Effect.void));
        }).pipe(Effect.asVoid);

        // 8. Build and deploy
        const stageInfo = yield* Effect.gen(function* () {
          if (config.type === "static") {
            return yield* Effect.gen(function* () {
              yield* Console.log("  installing deps...");
              yield* runLocal(wt, "bun", ["install", "--frozen-lockfile"]);

              yield* Console.log("  building...");
              yield* runLocal(wt, "bun", ["run", "build"], secrets);

              const remoteDir = deploymentPaths(config.domain, stage, DEPLOYMENT_ROOTS).staticFiles;
              yield* Console.log(`  syncing -> ${config.host}:${remoteDir}`);
              yield* components.staticArtifacts.publish({
                stage,
                domain: config.domain,
                host: config.host,
                worktreePath: wt,
                dist: config.dist,
              });

              return {
                type: "static",
                ref: actualRef,
                hash,
                port: null,
                host: config.host,
                domain: config.domain,
                deployed_at: DateTime.formatIso(yield* DateTime.now),
                healthcheck_path: config.healthcheckPath,
              } as StageInfo;
            }).pipe(Effect.onError(() => cleanup));
          }

          yield* Console.log(`  port: ${port}`);

          const paths = deploymentPaths(name, stage, DEPLOYMENT_ROOTS);
          const names = deploymentNames(name, stage);
          const unitName = names.serviceUnit;

          // ---------------------------------------------------------------
          // Zero-downtime deploy: old service keeps running while new starts
          // ---------------------------------------------------------------
          if (isZeroDowntime) {
            const oldPort = existingStage!.port!;
            const newDir = paths.serviceCandidate;
            const newUnitName = names.candidateUnit;

            yield* Console.log("  zero-downtime deploy");
            yield* Console.log(`  old port: ${oldPort} -> new port: ${port}`);

            const newStageInfo = yield* Effect.gen(function* () {
              // a. Rsync to new directory
              yield* Console.log(`  syncing -> ${config.host}:${newDir}`);
              yield* components.serviceArtifacts.publish({
                name,
                stage,
                host: config.host,
                worktreePath: wt,
                target: "candidate",
                secrets,
                port: port!,
              });

              yield* Console.log(`  installing systemd unit: ${newUnitName}`);
              yield* components.serviceInstances.install({
                name,
                stage,
                host: config.host,
                target: "candidate",
              });
              yield* Console.log("  starting new service...");
              yield* components.serviceInstances.start({
                name,
                stage,
                host: config.host,
                target: "candidate",
              });

              // e. Health check the new instance
              const candidateInfo: StageInfo = {
                type: "service",
                ref: actualRef,
                hash,
                port,
                host: config.host,
                domain: config.domain,
                deployed_at: DateTime.formatIso(yield* DateTime.now),
                healthcheck_path: config.healthcheckPath,
              };

              yield* Console.log("  checking health of new instance...");
              yield* healthCheck.check(candidateInfo, stage).pipe(
                Effect.catchAll((err) =>
                  Effect.gen(function* () {
                    yield* Console.error(`  health check failed: ${err.reason}`);
                    yield* Console.log("  rolling back — stopping new instance...");
                    return yield* new BuildError({
                      command: "health-check",
                      message: `New instance unhealthy, old service still running on port ${oldPort}. ${err.reason}`,
                    });
                  }),
                ),
              );
              return candidateInfo;
            }).pipe(Effect.onError(() => cleanupCandidate));

            yield* Console.log("  healthy — switching traffic");

            // f. Update metadata to new port, sync Caddy
            const base = existing ?? {
              repo: name,
              promoted: null,
              promoted_previous: null,
              stages: {},
            };
            yield* meta.saveProject(name, {
              ...base,
              stages: { ...base.stages, [stage]: newStageInfo },
            });

            yield* Console.log("  syncing routes...");
            yield* caddy.sync();

            // Stop old service
            yield* Console.log("  stopping old service...");
            yield* components.serviceInstances
              .stop({ name, stage, host: config.host, target: "final" })
              .pipe(Effect.catchAll(() => Effect.void));

            // Grace period for in-flight requests to drain
            yield* Console.log(`  grace period: ${RETIRE_GRACE_SECONDS}s`);
            yield* Effect.sleep(Duration.seconds(RETIRE_GRACE_SECONDS));

            // Cleanup: remove old unit + old directory, rename new to final
            yield* Console.log("  cleaning up old deployment...");
            yield* components.serviceInstances
              .remove({ name, stage, host: config.host, target: "final" })
              .pipe(Effect.catchAll(() => Effect.void));
            yield* components.serviceArtifacts
              .remove({ name, stage, host: config.host, target: "final" })
              .pipe(Effect.catchAll(() => Effect.void));

            // Rename new directory -> final, reinstall systemd unit at final name
            yield* components.serviceArtifacts.finalize({ name, stage, host: config.host });
            yield* components.serviceInstances
              .remove({ name, stage, host: config.host, target: "candidate" })
              .pipe(Effect.catchAll(() => Effect.void));
            yield* components.serviceInstances.install({
              name,
              stage,
              host: config.host,
              target: "final",
            });
            yield* components.serviceInstances.start({
              name,
              stage,
              host: config.host,
              target: "final",
            });

            return newStageInfo;
          }

          // ---------------------------------------------------------------
          // Fresh deploy (no existing service)
          // ---------------------------------------------------------------
          const remoteDir = paths.service;

          return yield* Effect.gen(function* () {
            // Rsync source (no local install — remote handles its own deps)
            yield* Console.log(`  syncing -> ${config.host}:${remoteDir}`);
            yield* components.serviceArtifacts.publish({
              name,
              stage,
              host: config.host,
              worktreePath: wt,
              target: "final",
              secrets,
              port: port!,
            });

            // Install + start systemd unit
            yield* Console.log(`  installing systemd unit: ${unitName}`);
            yield* components.serviceInstances.install({
              name,
              stage,
              host: config.host,
              target: "final",
            });

            yield* Console.log("  starting service...");
            yield* components.serviceInstances.start({
              name,
              stage,
              host: config.host,
              target: "final",
            });

            const freshStageInfo: StageInfo = {
              type: "service",
              ref: actualRef,
              hash,
              port,
              host: config.host,
              domain: config.domain,
              deployed_at: DateTime.formatIso(yield* DateTime.now),
              healthcheck_path: config.healthcheckPath,
            };

            // Health check before exposing to Caddy
            yield* Console.log("  checking health...");
            yield* healthCheck.check(freshStageInfo, stage);
            return freshStageInfo;
          }).pipe(Effect.onError(() => cleanup));
        });

        // 9. Save metadata + sync routes (skip if zero-downtime already handled it)
        if (!isZeroDowntime) {
          const base = existing ?? {
            repo: name,
            promoted: null,
            promoted_previous: null,
            stages: {},
          };
          yield* meta.saveProject(name, {
            ...base,
            stages: { ...base.stages, [stage]: stageInfo },
          });

          yield* Console.log("  syncing routes...");
          yield* caddy.sync();
        }

        return {
          name,
          stage,
          hash,
          type: stageInfo.type,
          previewUrl: previewUrl(hash, config.domain),
          autoPromote: config.autoPromote,
        } satisfies DeployResult;
      }),
    );

  // Promotion and rollback stay locked here so every project operation uses
  // the same orchestration boundary.
  const promote = (params: { name: string; stage: string; force?: boolean }) =>
    withProjectLock(params.name, promotion.promote(params));

  const rollback = (params: { name: string }) =>
    withProjectLock(params.name, promotion.rollback(params));

  // -------------------------------------------------------------------
  // teardown
  // -------------------------------------------------------------------

  const teardown = (params: { name: string; stage: string }) =>
    withProjectLock(
      params.name,
      Effect.gen(function* () {
        const { name, stage } = params;

        const project = yield* meta.getProject(name);
        if (!project || !project.stages[stage]) {
          return yield* new StageNotFoundError({ name, stage });
        }

        const info = project.stages[stage]!;

        if (info.type === "service") {
          yield* Console.log("  removing systemd unit...");
          yield* components.serviceInstances
            .remove({ name, stage, host: info.host, target: "final" })
            .pipe(Effect.catchAll(() => Effect.void));

          yield* Console.log("  removing project files...");
          yield* components.serviceArtifacts
            .remove({ name, stage, host: info.host, target: "final" })
            .pipe(Effect.catchAll(() => Effect.void));
        } else {
          yield* Console.log("  removing static files...");
          yield* components.staticArtifacts
            .remove({ stage, domain: info.domain, host: info.host })
            .pipe(Effect.catchAll(() => Effect.void));
        }

        // Remove worktree
        yield* Console.log("  removing worktree...");
        yield* gitMgr.worktrees.remove(name, stage).pipe(Effect.catchAll(() => Effect.void));

        // Update metadata
        const remainingStages = Object.fromEntries(
          Object.entries(project.stages).filter(([key]) => key !== stage),
        );
        const promoted = project.promoted === stage ? null : project.promoted;
        const promotedPrevious =
          project.promoted_previous === stage ? null : project.promoted_previous;

        yield* meta.saveProject(name, {
          ...project,
          promoted,
          promoted_previous: promotedPrevious,
          stages: remainingStages,
        });

        yield* caddy.sync();

        return { name, stage } satisfies TeardownResult;
      }),
    );

  // -------------------------------------------------------------------
  // listProjects
  // -------------------------------------------------------------------

  const listProjects = Effect.fnUntraced(function* () {
    const names = yield* meta.listProjects();
    return yield* Effect.forEach(
      names,
      Effect.fnUntraced(function* (name) {
        const project = yield* meta.getProject(name);
        return {
          name,
          stageCount: project ? Object.keys(project.stages).length : 0,
          promoted: project?.promoted ?? null,
        } satisfies ProjectInfo;
      }),
    );
  });

  // -------------------------------------------------------------------
  // getStages
  // -------------------------------------------------------------------

  const getStages = Effect.fnUntraced(function* (name: string) {
    const project = yield* meta.getProject(name);
    if (!project || Object.keys(project.stages).length === 0) {
      return null;
    }

    const stages = Object.entries(project.stages).map(
      ([stage, info]) =>
        ({
          stage,
          promoted: project.promoted === stage,
          type: info.type,
          port: info.port,
          domain: info.domain,
          ref: info.ref,
          hash: info.hash,
          deployed_at: info.deployed_at,
          previewUrl: previewUrl(info.hash, info.domain),
        }) satisfies StageDetail,
    );

    return {
      name,
      stages,
      production: project.promoted ? (project.stages[project.promoted]?.domain ?? null) : null,
    } satisfies StageListResult;
  });

  return { deploy, promote, rollback, teardown, listProjects, getStages };
});

export class DeployRunner extends Effect.Service<DeployRunner>()("infra/DeployRunner", {
  effect: makeDeployRunner,
  dependencies: [
    GitManager.Default,
    DeploymentComponents.Default,
    DeployMeta.Default,
    CaddyManager.Default,
    HealthCheck.Default,
    PromotionService.Default,
    BunContext.layer,
  ],
}) {}
