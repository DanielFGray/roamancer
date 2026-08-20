import { Console, Effect, Schema as S } from "effect";
import { CaddyManager, type CaddyError } from "./CaddyManager.ts";
import { DeployMeta, type DeployMetaErr } from "./DeployMeta.ts";
import { HealthCheck, type HealthCheckError } from "./HealthCheck.ts";

export class StageNotFoundError extends S.TaggedError<StageNotFoundError>()("StageNotFoundError", {
  name: S.String,
  stage: S.String,
}) {
  override get message() {
    return `Stage "${this.stage}" not found for project: ${this.name}`;
  }
}

export class NothingToRollbackError extends S.TaggedError<NothingToRollbackError>()(
  "NothingToRollbackError",
  { name: S.String },
) {
  override get message() {
    return `No previous promotion to rollback to for: ${this.name}`;
  }
}

export interface RollbackResult {
  readonly name: string;
  readonly stage: string;
}

export interface PromoteResult {
  readonly name: string;
  readonly stage: string;
  readonly domain: string;
}

export interface PromotionServiceShape {
  readonly promote: (params: {
    readonly name: string;
    readonly stage: string;
    readonly force?: boolean;
  }) => Effect.Effect<
    PromoteResult,
    StageNotFoundError | HealthCheckError | CaddyError | DeployMetaErr
  >;
  readonly rollback: (params: {
    readonly name: string;
  }) => Effect.Effect<
    RollbackResult,
    NothingToRollbackError | StageNotFoundError | CaddyError | DeployMetaErr
  >;
}

export const makePromotionService = (
  meta: DeployMeta,
  caddy: CaddyManager,
  healthCheck: HealthCheck,
): PromotionServiceShape => {
  const promote = (params: {
    readonly name: string;
    readonly stage: string;
    readonly force?: boolean;
  }) =>
    Effect.gen(function* () {
      const { name, stage, force } = params;
      const project = yield* meta.getProject(name);
      if (!project || Object.keys(project.stages).length === 0) {
        return yield* new StageNotFoundError({ name, stage });
      }

      const stageInfo = project.stages[stage];
      if (!stageInfo) {
        return yield* new StageNotFoundError({ name, stage });
      }

      if (!force) {
        yield* Console.log(`  checking health of ${stage}...`);
        yield* healthCheck
          .check(stageInfo, stage)
          .pipe(
            Effect.tapError((err) =>
              Console.error(`Health check failed: ${err.reason}\nUse --force to skip.`),
            ),
          );
        yield* Console.log("  healthy");
      } else {
        yield* Console.log("  skipping health check (--force)");
      }

      yield* meta.saveProject(name, {
        ...project,
        promoted: stage,
        promoted_previous: project.promoted,
      });
      yield* caddy.sync();

      return { name, stage, domain: stageInfo.domain } satisfies PromoteResult;
    });

  const rollback = (params: { readonly name: string }) =>
    Effect.gen(function* () {
      const { name } = params;
      const project = yield* meta.getProject(name);
      if (!project || !project.promoted_previous) {
        return yield* new NothingToRollbackError({ name });
      }

      const previousStage = project.promoted_previous;
      if (!project.stages[previousStage]) {
        return yield* new StageNotFoundError({ name, stage: previousStage });
      }

      yield* meta.saveProject(name, {
        ...project,
        promoted: previousStage,
        promoted_previous: project.promoted,
      });
      yield* caddy.sync();

      return { name, stage: previousStage } satisfies RollbackResult;
    });

  return { promote, rollback };
};

export class PromotionService extends Effect.Service<PromotionService>()("infra/PromotionService", {
  effect: Effect.gen(function* () {
    return makePromotionService(yield* DeployMeta, yield* CaddyManager, yield* HealthCheck);
  }),
  dependencies: [DeployMeta.Default, CaddyManager.Default, HealthCheck.Default],
}) {}
