import { expect, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { deploymentPaths } from "../lib/deployment.ts";
import { makeDeploymentComponents } from "./DeploymentComponents.ts";
import { SchemaResolver } from "./SchemaResolver.ts";
import { makeTestServices, testLayers } from "../test/layers.ts";

const componentsFromTestLayers = (state: ReturnType<typeof makeTestServices>) =>
  Effect.gen(function* () {
    yield* Effect.void;
    return yield* makeDeploymentComponents;
  }).pipe(Effect.provide(Layer.mergeAll(testLayers(state), SchemaResolver.Default)));

it.effect("publishes and removes static artifacts through their owned path", () => {
  const state = makeTestServices();

  return Effect.gen(function* () {
    const components = yield* componentsFromTestLayers(state);
    yield* components.staticArtifacts.publish({
      stage: "main",
      domain: "demo.example",
      host: "test-host",
      worktreePath: "/test/worktrees/demo/main",
      dist: "dist",
      target: "candidate",
    });
    yield* components.staticArtifacts.remove({
      stage: "main",
      domain: "demo.example",
      host: "test-host",
      target: "candidate",
    });

    expect(state.calls.ssh).toEqual([
      { host: "test-host", command: "mkdir -p '/srv/www/demo.example/stages/main.new'" },
      {
        host: "test-host",
        command: "rsync /test/worktrees/demo/main/dist/ /srv/www/demo.example/stages/main.new",
      },
      { host: "test-host", command: "rm -rf '/srv/www/demo.example/stages/main.new'" },
    ]);
  });
});

it.effect("activates and completes static candidates through owned paths", () => {
  const state = makeTestServices();

  return Effect.gen(function* () {
    const components = yield* componentsFromTestLayers(state);
    const hadPrevious = yield* components.staticArtifacts.activate({
      stage: "main",
      domain: "demo.example",
      host: "test-host",
    });
    yield* components.staticArtifacts.complete({
      stage: "main",
      domain: "demo.example",
      host: "test-host",
    });

    expect(hadPrevious).toBe(false);
    expect(state.calls.ssh).toHaveLength(2);
    expect(state.calls.ssh[0]?.command).toContain("mv '/srv/www/demo.example/stages/main.new'");
    expect(state.calls.ssh[0]?.command).toContain("mv '/srv/www/demo.example/stages/main'");
    expect(state.calls.ssh[0]?.command).toContain("if mv");
    expect(state.calls.ssh[1]).toEqual({
      host: "test-host",
      command: "rm -rf '/srv/www/demo.example/stages/main.previous'",
    });
  });
});

it.effect("keeps service artifact and instance cleanup on candidate names", () => {
  const state = makeTestServices();

  return Effect.gen(function* () {
    const components = yield* componentsFromTestLayers(state);
    yield* components.serviceArtifacts.publish({
      name: "demo",
      stage: "main",
      host: "test-host",
      worktreePath: "/test/worktrees/demo/main",
      target: "candidate",
      secrets: { TOKEN: "value" },
      port: 3002,
    });
    yield* components.serviceInstances.install({
      name: "demo",
      stage: "main",
      host: "test-host",
      target: "candidate",
    });
    yield* components.serviceInstances.remove({
      name: "demo",
      stage: "main",
      host: "test-host",
      target: "candidate",
    });
    yield* components.serviceArtifacts.remove({
      name: "demo",
      stage: "main",
      host: "test-host",
      target: "candidate",
    });

    expect(state.calls.ssh).toContainEqual({
      host: "test-host",
      command: "mkdir -p /srv/projects/demo/stages/main.new",
    });
    expect(state.calls.ssh).toContainEqual({
      host: "test-host",
      command: "rm -rf /srv/projects/demo/stages/main.new",
    });
    expect(state.calls.ssh).not.toContainEqual({
      host: "test-host",
      command: "rm -rf /srv/projects/demo/stages/main",
    });
    expect(state.calls.systemd).toEqual([
      { action: "install", host: "test-host", unit: "infra-demo-main-new" },
      { action: "remove", host: "test-host", unit: "infra-demo-main-new" },
    ]);
  });
});

it.effect("finalizes a candidate using only the component-owned paths", () => {
  const state = makeTestServices();

  return Effect.gen(function* () {
    const components = yield* componentsFromTestLayers(state);
    yield* components.serviceArtifacts.finalize({ name: "demo", stage: "main", host: "test-host" });

    expect(state.calls.ssh).toEqual([
      {
        host: "test-host",
        command:
          "if [ -e '/srv/projects/demo/stages/main.new' ]; then rm -rf '/srv/projects/demo/stages/main' && mv '/srv/projects/demo/stages/main.new' '/srv/projects/demo/stages/main'; fi",
      },
    ]);
  });
});

it.effect("seeds deployment secrets and leaves them through artifact cleanup", () => {
  const state = makeTestServices();
  state.files.set("/test/worktrees/demo/main/.env.schema", "TOKEN=seeded\n");

  return Effect.gen(function* () {
    const components = yield* componentsFromTestLayers(state);
    const resolved = yield* components.secrets.resolve("demo", "/test/worktrees/demo/main");
    const current = yield* components.secrets.resolve("demo", "/test/worktrees/demo/main");
    yield* components.serviceArtifacts.remove({
      name: "demo",
      stage: "main",
      host: "test-host",
      target: "final",
    });

    expect(resolved).toEqual({ TOKEN: "seeded" });
    expect(current).toEqual(resolved);
    expect(state.openBao.get("demo")).toEqual({ TOKEN: "seeded" });
    expect(state.openBao.has("demo")).toBe(true);
  });
});

it("keeps component paths derived from the same deployment layout", () => {
  const paths = deploymentPaths("demo", "main");
  expect(paths.worktree).not.toBe(paths.service);
  expect(paths.serviceCandidate).toBe(`${paths.service}.new`);
});
