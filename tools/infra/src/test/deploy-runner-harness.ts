import { Effect, Layer } from "effect";
import {
  DeploymentComponents,
  makeDeploymentComponents,
} from "../services/DeploymentComponents.ts";
import { CaddyManager } from "../services/CaddyManager.ts";
import { DeployMeta } from "../services/DeployMeta.ts";
import { HealthCheck } from "../services/HealthCheck.ts";
import { makeDeployRunner } from "../services/DeployRunner.ts";
import { makePromotionService, PromotionService } from "../services/PromotionService.ts";
import { StageOperations, makeStageOperations } from "../services/StageOperations.ts";
import { BuildError, BuildRunner } from "../services/BuildRunner.ts";
import { SecretResolver } from "../services/SecretResolver.ts";
import { makeTestServices, testLayers } from "./layers.ts";

export const runnerFromTestLayers = (state: ReturnType<typeof makeTestServices>) => {
  state.files.set(
    "/test/worktrees/demo/main/package.json",
    JSON.stringify({
      scripts: { deploy: "bun run start" },
      infra: { host: "test-host", domain: "demo" },
    }),
  );
  const external = Layer.mergeAll(testLayers(state), SecretResolver.Default);
  const components = Layer.effect(
    DeploymentComponents,
    makeDeploymentComponents.pipe(
      Effect.map((value) => ({ ...value, _tag: "infra/DeploymentComponents" as const })),
    ),
  ).pipe(Layer.provide(external));
  const promotion = Layer.effect(
    PromotionService,
    Effect.gen(function* () {
      const service = makePromotionService(
        yield* DeployMeta,
        yield* CaddyManager,
        yield* HealthCheck,
      );
      return { _tag: "infra/PromotionService" as const, ...service };
    }),
  ).pipe(Layer.provide(external));
  const stageOperations = Layer.effect(
    StageOperations,
    makeStageOperations.pipe(
      Effect.map((value) => ({ ...value, _tag: "infra/StageOperations" as const })),
    ),
  ).pipe(
    Layer.provide(
      Layer.mergeAll(
        external,
        components,
        Layer.succeed(BuildRunner, {
          _tag: "infra/BuildRunner",
          run: (_cwd, command, args) =>
            state.failBuild && `${command} ${args.join(" ")}`.includes(state.failBuild)
              ? Effect.fail(
                  new BuildError({
                    command: `${command} ${args.join(" ")}`,
                    message: "build failed",
                  }),
                )
              : Effect.void,
        }),
      ),
    ),
  );

  return Effect.gen(function* () {
    yield* Effect.void;
    return yield* makeDeployRunner;
  }).pipe(Effect.provide(Layer.mergeAll(external, components, promotion, stageOperations)));
};

/** Component boundary used by service-level tests that do not need DeployRunner. */
export const deploymentComponentsFromTestLayers = (state: ReturnType<typeof makeTestServices>) => {
  const external = Layer.mergeAll(testLayers(state), SecretResolver.Default);
  const components = Layer.effect(
    DeploymentComponents,
    makeDeploymentComponents.pipe(
      Effect.map((value) => ({ ...value, _tag: "infra/DeploymentComponents" as const })),
    ),
  ).pipe(Layer.provide(external));
  return Layer.mergeAll(external, components);
};
