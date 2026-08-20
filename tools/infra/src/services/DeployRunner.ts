import { Console, Duration, Effect } from "effect";

import { GitManager, sanitizeRef } from "./GitManager.ts";
import { DeployMeta } from "./DeployMeta.ts";
import { DeploymentComponents } from "./DeploymentComponents.ts";
import { PromotionService, StageNotFoundError } from "./PromotionService.ts";
import { StageOperations } from "./StageOperations.ts";
import { RETIRE_GRACE_SECONDS } from "../lib/config.ts";
import { previewUrl } from "../lib/deployment.ts";

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

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
// Service
// ---------------------------------------------------------------------------

export const makeDeployRunner = Effect.gen(function* () {
  const gitMgr = yield* GitManager;
  const meta = yield* DeployMeta;
  const components = yield* DeploymentComponents;
  const stageOperations = yield* StageOperations;
  const promotion = yield* PromotionService;

  // Per-project mutex: prevents concurrent deploys to the same project
  // from corrupting state (e.g. two rapid webhook pushes)
  const projectLocks = new Map<string, Effect.Semaphore>();
  const withProjectLock = <A, E, R>(name: string, effect: Effect.Effect<A, E, R>) => {
    if (!projectLocks.has(name)) {
      projectLocks.set(name, Effect.unsafeMakeSemaphore(1));
    }
    return projectLocks.get(name)!.withPermits(1)(effect);
  };

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

        // Preparation owns only the worktree. Artifact cleanup starts later, after its owner exists.
        const prepared = yield* Effect.gen(function* () {
          const config = yield* stageOperations.readConfig(wt, name);

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

          return { config, secrets, existing, isZeroDowntime, port };
        }).pipe(Effect.onError(() => stageOperations.cleanupWorktree(name, stage)));

        const { config, secrets, existing, isZeroDowntime, port } = prepared;

        // StageOperations owns build, artifact/instance cleanup, health, and commit policy.
        const stageInfo =
          config.type === "static"
            ? yield* stageOperations.publishStatic({
                name,
                stage,
                ref: actualRef,
                hash,
                worktreePath: wt,
                config,
                secrets,
              })
            : isZeroDowntime
              ? yield* stageOperations.deployService({
                  name,
                  stage,
                  ref: actualRef,
                  hash,
                  worktreePath: wt,
                  config,
                  secrets,
                  port: port!,
                  target: "candidate",
                })
              : yield* stageOperations.deployService({
                  name,
                  stage,
                  ref: actualRef,
                  hash,
                  worktreePath: wt,
                  config,
                  secrets,
                  port: port!,
                  target: "final",
                });

        if (isZeroDowntime) {
          yield* Console.log("  healthy — switching traffic");
          yield* stageOperations.commit({
            name,
            stage,
            info: stageInfo,
            existing,
            target: "candidate",
          });

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
        } else {
          yield* stageOperations.commit({
            name,
            stage,
            info: stageInfo,
            existing,
            target: "final",
          });
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

        yield* stageOperations.teardown({ name, stage, info: project.stages[stage]!, project });

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
    PromotionService.Default,
    StageOperations.Default,
  ],
}) {}
