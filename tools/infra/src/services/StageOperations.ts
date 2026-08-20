import { DateTime, Duration, Effect, Schema as S } from "effect";
import { BunContext } from "@effect/platform-bun";
import * as FileSystem from "@effect/platform/FileSystem";
import * as Path from "@effect/platform/Path";
import { CaddyManager } from "./CaddyManager.ts";
import { DeployMeta, type ProjectMeta, type StageInfo } from "./DeployMeta.ts";
import { DeploymentComponents, type ServiceTarget } from "./DeploymentComponents.ts";
import { GitManager } from "./GitManager.ts";
import { HealthCheck } from "./HealthCheck.ts";
import { BuildRunner } from "./BuildRunner.ts";
import { CADDY_HOST, DEPLOYMENT_ROOTS, RETIRE_GRACE_SECONDS } from "../lib/config.ts";
import { deploymentPaths } from "../lib/deployment.ts";

export class ProjectConfigError extends S.TaggedError<ProjectConfigError>()("ProjectConfigError", {
  message: S.String,
}) {}

export const PackageJson = S.Struct({
  scripts: S.optional(S.Record({ key: S.String, value: S.String })),
  infra: S.optional(
    S.Struct({
      domain: S.optional(S.String),
      dist: S.optional(S.String),
      host: S.optional(S.String),
      autoPromote: S.optional(S.String),
      healthcheck: S.optional(
        S.Struct({ path: S.optional(S.String), timeout: S.optional(S.Number) }),
      ),
    }),
  ),
});

export interface ProjectConfig {
  readonly type: "static" | "service";
  readonly domain: string;
  readonly dist: string;
  readonly host: string;
  readonly healthcheckPath: string;
  readonly autoPromote: string | undefined;
}

export interface StaticDeploymentInput {
  readonly name: string;
  readonly stage: string;
  readonly ref: string;
  readonly hash: string;
  readonly worktreePath: string;
  readonly config: ProjectConfig;
  readonly secrets: Readonly<Record<string, string>>;
}

export interface ServiceDeploymentInput {
  readonly name: string;
  readonly stage: string;
  readonly ref: string;
  readonly hash: string;
  readonly worktreePath: string;
  readonly config: ProjectConfig;
  readonly secrets: Readonly<Record<string, string>>;
  readonly port: number;
  readonly target: ServiceTarget;
}

export interface CommitInput {
  readonly name: string;
  readonly stage: string;
  readonly info: StageInfo;
  readonly existing: ProjectMeta | null;
  readonly target: ServiceTarget | "static";
}

type ServiceStageInfo = Omit<StageInfo, "type" | "port"> & {
  readonly type: "service";
  readonly port: number;
};

export interface TeardownInput {
  readonly name: string;
  readonly stage: string;
  readonly info: StageInfo;
  readonly project: ProjectMeta;
}

export const makeStageOperations = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const git = yield* GitManager;
  const meta = yield* DeployMeta;
  const caddy = yield* CaddyManager;
  const components = yield* DeploymentComponents;
  const health = yield* HealthCheck;
  const build = yield* BuildRunner;

  const removeService = (name: string, stage: string, host: string, target: ServiceTarget) =>
    Effect.gen(function* () {
      yield* components.serviceInstances.remove({ name, stage, host, target });
      yield* components.serviceArtifacts.remove({ name, stage, host, target });
    });

  const removeWorktree = (name: string, stage: string) =>
    git.worktrees.remove(name, stage).pipe(Effect.asVoid);

  const cleanupWorktree = (name: string, stage: string) =>
    removeWorktree(name, stage).pipe(Effect.catchAll(() => Effect.void));

  const readConfig = Effect.fnUntraced(function* (worktreePath: string, name: string) {
    const packagePath = path.join(worktreePath, "package.json");
    if (!(yield* fs.exists(packagePath))) {
      return yield* new ProjectConfigError({ message: `No package.json found in ${worktreePath}` });
    }
    const pkg = yield* S.decodeUnknown(S.parseJson(PackageJson))(
      yield* fs.readFileString(packagePath),
    );
    const hasDeploy = pkg.scripts?.deploy !== undefined;
    const hasBuild = pkg.scripts?.build !== undefined;
    if (!hasDeploy && !hasBuild) {
      return yield* new ProjectConfigError({
        message: `${name}: package.json needs a "build" or "deploy" script`,
      });
    }
    const infra = pkg.infra ?? {};
    return {
      type: hasDeploy ? "service" : "static",
      domain: infra.domain ?? name,
      dist: infra.dist ?? "dist",
      host: infra.host ?? CADDY_HOST,
      healthcheckPath: infra.healthcheck?.path ?? "/health",
      autoPromote: infra.autoPromote,
    } satisfies ProjectConfig;
  });

  const publishStatic = Effect.fnUntraced(function* (input: StaticDeploymentInput) {
    let publicationStarted = false;
    const removeStatic = components.staticArtifacts
      .remove({
        stage: input.stage,
        domain: input.config.domain,
        host: input.config.host,
        target: "candidate",
      })
      .pipe(Effect.catchAll(() => Effect.void));
    const cleanup = Effect.gen(function* () {
      yield* cleanupWorktree(input.name, input.stage);
      if (publicationStarted) yield* removeStatic;
    });
    return yield* Effect.gen(function* () {
      yield* build.run(input.worktreePath, "bun", ["install", "--frozen-lockfile"]);
      yield* build.run(input.worktreePath, "bun", ["run", "build"], input.secrets);
      publicationStarted = true;
      yield* components.staticArtifacts.publish({
        stage: input.stage,
        domain: input.config.domain,
        host: input.config.host,
        worktreePath: input.worktreePath,
        dist: input.config.dist,
        target: "candidate",
      });
      return {
        type: "static",
        ref: input.ref,
        hash: input.hash,
        port: null,
        host: input.config.host,
        domain: input.config.domain,
        deployed_at: DateTime.formatIso(yield* DateTime.now),
        healthcheck_path: input.config.healthcheckPath,
      } satisfies StageInfo;
    }).pipe(Effect.onError(() => cleanup));
  });

  const acquireService = Effect.fnUntraced(function* (input: ServiceDeploymentInput) {
    const cleanup = Effect.gen(function* () {
      yield* cleanupWorktree(input.name, input.stage);
      yield* removeService(input.name, input.stage, input.config.host, input.target).pipe(
        Effect.catchAll(() => Effect.void),
      );
    });
    const info = {
      type: "service",
      ref: input.ref,
      hash: input.hash,
      port: input.port,
      host: input.config.host,
      domain: input.config.domain,
      deployed_at: DateTime.formatIso(yield* DateTime.now),
      healthcheck_path: input.config.healthcheckPath,
    } satisfies StageInfo;

    return yield* Effect.gen(function* () {
      yield* components.serviceArtifacts.publish({
        name: input.name,
        stage: input.stage,
        host: input.config.host,
        worktreePath: input.worktreePath,
        target: input.target,
        secrets: input.secrets,
        port: input.port,
      });
      yield* components.serviceInstances.install({
        name: input.name,
        stage: input.stage,
        host: input.config.host,
        target: input.target,
      });
      yield* components.serviceInstances.start({
        name: input.name,
        stage: input.stage,
        host: input.config.host,
        target: input.target,
      });
      yield* health.check(info, input.stage);
      return info;
    }).pipe(Effect.onError(() => cleanup));
  });

  const finalize = Effect.fnUntraced(function* (input: {
    readonly name: string;
    readonly stage: string;
    readonly host: string;
    readonly info: ServiceStageInfo;
  }) {
    const artifacts = yield* components.serviceArtifacts.inspect(input);
    const instances = yield* components.serviceInstances.inspect(input);
    const paths = deploymentPaths(input.name, input.stage, DEPLOYMENT_ROOTS);
    const candidateCommitted =
      artifacts.candidate &&
      artifacts.candidatePort === input.info.port &&
      instances.candidateWorkingDirectory === paths.serviceCandidate;
    const finalArtifactCommitted = artifacts.final && artifacts.finalPort === input.info.port;
    const finalCommitted =
      finalArtifactCommitted && instances.finalWorkingDirectory === paths.service;
    const hasCommittedIdentity = candidateCommitted || finalArtifactCommitted;
    const hasOrphanedIdentity = artifacts.candidate || instances.candidate;

    if (!hasCommittedIdentity) {
      if (hasOrphanedIdentity) {
        yield* removeService(input.name, input.stage, input.host, "candidate");
      }
      return false;
    }

    // A healthy final that matches metadata is the normal steady state. An
    // unrelated candidate can be removed without replaying traffic commit.
    if (!candidateCommitted && finalCommitted && instances.finalActive) {
      if (hasOrphanedIdentity) {
        yield* removeService(input.name, input.stage, input.host, "candidate");
      }
      return false;
    }

    // Reconcile traffic while the candidate or its replacement final identity
    // still proves that this operation needs recovery.
    yield* caddy.sync();

    if (candidateCommitted) {
      if (instances.finalActive) {
        yield* components.serviceInstances.stop({ ...input, target: "final" });
        yield* Effect.sleep(Duration.seconds(RETIRE_GRACE_SECONDS));
      }
      yield* components.serviceInstances.remove({ ...input, target: "final" });
      yield* components.serviceArtifacts.finalize(input);
    }
    if (instances.candidate) {
      yield* components.serviceInstances.remove({ ...input, target: "candidate" });
    }
    if (!finalCommitted || !instances.finalActive) {
      yield* components.serviceInstances.install({ ...input, target: "final" });
      yield* components.serviceInstances.start({ ...input, target: "final" });
    }
    return true;
  });

  const commit = Effect.fnUntraced(function* (input: CommitInput) {
    const cleanup = Effect.gen(function* () {
      yield* cleanupWorktree(input.name, input.stage);
      if (input.info.type === "service") {
        yield* removeService(
          input.name,
          input.stage,
          input.info.host,
          input.target === "static" ? "final" : input.target,
        ).pipe(Effect.catchAll(() => Effect.void));
      }
    });
    const cleanupStatic = Effect.gen(function* () {
      yield* cleanupWorktree(input.name, input.stage);
      yield* components.staticArtifacts
        .remove({
          stage: input.stage,
          domain: input.info.domain,
          host: input.info.host,
          target: "candidate",
        })
        .pipe(Effect.catchAll(() => Effect.void));
    });
    const project = {
      ...(input.existing ?? {
        repo: input.name,
        promoted: null,
        promoted_previous: null,
        stages: {},
      }),
      stages: { ...(input.existing?.stages ?? {}), [input.stage]: input.info },
    } satisfies ProjectMeta;

    if (input.info.type === "static") {
      const hadPrevious = yield* components.staticArtifacts
        .activate({
          stage: input.stage,
          domain: input.info.domain,
          host: input.info.host,
        })
        .pipe(Effect.onError(() => cleanupStatic));
      yield* meta.saveProject(input.name, project).pipe(
        Effect.onError(() =>
          components.staticArtifacts
            .rollback({
              stage: input.stage,
              domain: input.info.domain,
              host: input.info.host,
              hadPrevious,
            })
            .pipe(
              Effect.catchAll(() => Effect.void),
              Effect.andThen(cleanupStatic),
            ),
        ),
      );
      yield* components.staticArtifacts.complete({
        stage: input.stage,
        domain: input.info.domain,
        host: input.info.host,
      });
      yield* caddy.sync();
      return;
    }

    yield* meta.saveProject(input.name, project).pipe(Effect.onError(() => cleanup));
    yield* caddy.sync();
  });

  const teardown = Effect.fnUntraced(function* (input: TeardownInput) {
    const remainingStages = Object.fromEntries(
      Object.entries(input.project.stages).filter(([stage]) => stage !== input.stage),
    );
    const next = {
      ...input.project,
      promoted: input.project.promoted === input.stage ? null : input.project.promoted,
      promoted_previous:
        input.project.promoted_previous === input.stage ? null : input.project.promoted_previous,
      stages: remainingStages,
    } satisfies ProjectMeta;

    if (input.info.type === "service") {
      yield* removeService(input.name, input.stage, input.info.host, "candidate");
      yield* removeService(input.name, input.stage, input.info.host, "final");
    } else {
      yield* components.staticArtifacts.remove({
        stage: input.stage,
        domain: input.info.domain,
        host: input.info.host,
        target: "candidate",
      });
      yield* components.staticArtifacts.removeBackup({
        stage: input.stage,
        domain: input.info.domain,
        host: input.info.host,
      });
      yield* components.staticArtifacts.remove({
        stage: input.stage,
        domain: input.info.domain,
        host: input.info.host,
        target: "final",
      });
    }
    yield* removeWorktree(input.name, input.stage);

    if (Object.keys(remainingStages).length === 0) {
      yield* meta.deleteProject(input.name);
    } else {
      yield* meta.saveProject(input.name, next);
    }

    yield* caddy.sync();
  });

  return { readConfig, cleanupWorktree, publishStatic, acquireService, commit, finalize, teardown };
});

export class StageOperations extends Effect.Service<StageOperations>()("infra/StageOperations", {
  effect: makeStageOperations,
  dependencies: [
    DeploymentComponents.Default,
    GitManager.Default,
    DeployMeta.Default,
    CaddyManager.Default,
    HealthCheck.Default,
    BuildRunner.Default,
    BunContext.layer,
    Path.layer,
  ],
}) {}
