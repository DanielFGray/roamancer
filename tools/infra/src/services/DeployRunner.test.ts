import { expect, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import * as HttpClientError from "@effect/platform/HttpClientError";
import { makeDeployRunner } from "./DeployRunner.ts";
import { DeploymentComponents, makeDeploymentComponents } from "./DeploymentComponents.ts";
import { CaddyError, CaddyManager } from "./CaddyManager.ts";
import { DeployMeta } from "./DeployMeta.ts";
import { HealthCheck } from "./HealthCheck.ts";
import { makePromotionService, PromotionService } from "./PromotionService.ts";
import { SecretResolver } from "./SecretResolver.ts";
import { SshError } from "./SshClient.ts";
import { makeTestServices, seedProject, testLayers } from "../test/layers.ts";

const serviceStage = () => ({
  type: "service" as const,
  ref: "main",
  hash: "old-hash",
  port: 3001,
  host: "test-host",
  domain: "demo",
  deployed_at: "2026-01-01T00:00:00.000Z",
});

const runnerFromTestLayers = (state: ReturnType<typeof makeTestServices>) => {
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

  return Effect.gen(function* () {
    yield* Effect.void;
    return yield* makeDeployRunner;
  }).pipe(Effect.provide(Layer.mergeAll(external, components, promotion)));
};

it.effect("cleans a failed fresh service without leaving its owned final artifact", () => {
  const state = makeTestServices();
  state.failSystemdAction = "install";

  return Effect.gen(function* () {
    const runner = yield* runnerFromTestLayers(state);
    const result = yield* Effect.either(
      runner.deploy({ name: "demo", ref: "main", stage: "main" }),
    );

    expect(result._tag).toBe("Left");
    if (result._tag === "Left") {
      const error = result.left;
      expect(error).toBeInstanceOf(SshError);
      expect(error).toMatchObject({ message: "install failed" });
    }
    expect(state.calls.systemd).toEqual([
      { action: "install", host: "test-host", unit: "infra-demo-main" },
      { action: "remove", host: "test-host", unit: "infra-demo-main" },
    ]);
    expect(state.calls.ssh).toContainEqual({
      host: "test-host",
      command: "rm -rf /srv/projects/demo/stages/main",
    });
    expect(state.calls.git).toContain("removeWorktree demo main");
  });
});

it.effect(
  "cleans a failed rolling candidate without removing the existing final deployment",
  () => {
    const state = makeTestServices();
    state.failSystemdAction = "install";
    seedProject(state, "demo", { stages: { main: serviceStage() } });

    return Effect.gen(function* () {
      const runner = yield* runnerFromTestLayers(state);
      const result = yield* Effect.either(
        runner.deploy({ name: "demo", ref: "main", stage: "main" }),
      );

      expect(result._tag).toBe("Left");
      if (result._tag === "Left") {
        const error = result.left;
        expect(error).toBeInstanceOf(SshError);
        expect(error).toMatchObject({ message: "install failed" });
      }
      expect(state.calls.systemd).toEqual([
        { action: "install", host: "test-host", unit: "infra-demo-main-new" },
        { action: "remove", host: "test-host", unit: "infra-demo-main-new" },
      ]);
      expect(state.calls.ssh).toContainEqual({
        host: "test-host",
        command: "rm -rf /srv/projects/demo/stages/main.new",
      });
      expect(state.calls.ssh).not.toContainEqual({
        host: "test-host",
        command: "rm -rf /srv/projects/demo/stages/main",
      });
    });
  },
);

it.effect("preserves the candidate after metadata commit when Caddy sync fails", () => {
  const state = makeTestServices();
  state.failCaddySync = true;
  state.nextPort = 3002;
  seedProject(state, "demo", { stages: { main: serviceStage() } });

  return Effect.gen(function* () {
    const runner = yield* runnerFromTestLayers(state);
    const result = yield* Effect.either(
      runner.deploy({ name: "demo", ref: "main", stage: "main" }),
    );

    expect(result._tag).toBe("Left");
    if (result._tag === "Left") {
      const error = result.left;
      expect(error).toBeInstanceOf(CaddyError);
      expect(error).toMatchObject({ message: "caddy sync failed" });
    }
    expect(state.projects.get("demo")?.stages.main?.port).toBe(3002);
    expect(state.projects.get("demo")?.stages.main?.hash).toBe("hash-main");
    expect(state.calls.events).toEqual(["health.check:main", "metadata.save", "caddy.sync"]);
    expect(state.calls.ssh).not.toContainEqual({
      host: "test-host",
      command: "rm -rf /srv/projects/demo/stages/main.new",
    });
    expect(state.calls.systemd).toEqual([
      { action: "install", host: "test-host", unit: "infra-demo-main-new" },
      { action: "start", host: "test-host", unit: "infra-demo-main-new" },
    ]);
  });
});

it.effect("removes the worktree when secret seeding fails during preparation", () => {
  const state = makeTestServices();
  state.failOpenBaoPut = true;
  state.files.set("/test/worktrees/demo/main/.env.example", "TOKEN=seeded\n");

  return Effect.gen(function* () {
    const runner = yield* runnerFromTestLayers(state);
    const result = yield* Effect.either(
      runner.deploy({ name: "demo", ref: "main", stage: "main" }),
    );

    expect(result._tag).toBe("Left");
    if (result._tag === "Left") {
      const error = result.left;
      expect(error).toBeInstanceOf(HttpClientError.RequestError);
      expect(error).toMatchObject({ description: "OpenBao seed failed" });
    }
    expect(state.calls.git).toContain("removeWorktree demo main");
    expect(state.calls.ssh).toEqual([]);
    expect(state.calls.systemd).toEqual([]);
  });
});
