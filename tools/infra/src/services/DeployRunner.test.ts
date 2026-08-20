import { expect, it } from "@effect/vitest";
import { Duration, Effect, Fiber, TestClock } from "effect";
import * as HttpClientError from "@effect/platform/HttpClientError";
import { CaddyError } from "./CaddyManager.ts";
import { DeployMetaError } from "./DeployMeta.ts";
import { HealthCheckError } from "./HealthCheck.ts";
import { SshError } from "./SshClient.ts";
import { runnerFromTestLayers } from "../test/deploy-runner-harness.ts";
import { makeTestServices, seedProject } from "../test/layers.ts";

const serviceStage = () => ({
  type: "service" as const,
  ref: "main",
  hash: "old-hash",
  port: 3001,
  host: "test-host",
  domain: "demo",
  deployed_at: "2026-01-01T00:00:00.000Z",
});

const runWithTestClock = <A, E>(effect: Effect.Effect<A, E>, trace?: Array<string>) =>
  Effect.gen(function* () {
    const fiber = yield* effect.pipe(Effect.fork);
    yield* Effect.yieldNow();
    trace?.push("grace.sleep");
    yield* TestClock.adjust(Duration.seconds(30));
    return yield* Fiber.join(fiber);
  }).pipe(Effect.provide(TestClock.defaultTestClock));

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

it.effect("recovers an interrupted finalize without persisting phase state", () => {
  const state = makeTestServices();
  state.nextPort = 3002;
  state.failSystemdInstallUnit = "infra-demo-main";
  seedProject(state, "demo", { stages: { main: serviceStage() } });

  return Effect.gen(function* () {
    const runner = yield* runnerFromTestLayers(state);
    const firstFiber = yield* Effect.either(
      runner.deploy({ name: "demo", ref: "main", stage: "main" }),
    ).pipe(Effect.fork);
    yield* TestClock.adjust(Duration.seconds(30));
    const first = yield* Fiber.join(firstFiber);

    expect(first._tag).toBe("Left");
    expect(state.projects.get("demo")?.stages.main?.port).toBe(3002);
    expect(state.candidateArtifact).toBe(false);
    expect(state.finalArtifact).toBe(true);

    delete state.failSystemdInstallUnit;
    const retryFiber = yield* runner
      .deploy({ name: "demo", ref: "main", stage: "main" })
      .pipe(Effect.fork);
    yield* TestClock.adjust(Duration.seconds(30));
    yield* Fiber.join(retryFiber);

    expect(state.candidateArtifact).toBe(false);
    expect(state.candidateUnit).toBe(false);
    expect(state.finalArtifact).toBe(true);
    expect(state.finalUnit).toBe(true);
    expect(state.projects.get("demo")?.stages.main?.hash).toBe("hash-main");
  }).pipe(Effect.provide(TestClock.defaultTestClock));
});

it.effect("removes an abandoned candidate whose cleanup failed before commit", () => {
  const state = makeTestServices();
  state.nextPort = 3002;
  state.failSshCommand = "rm -rf /srv/projects/demo/stages/main.new";
  state.healthError = new HealthCheckError({ stage: "main", reason: "unhealthy" });
  seedProject(state, "demo", { stages: { main: serviceStage() } });

  return Effect.gen(function* () {
    const runner = yield* runnerFromTestLayers(state);
    const first = yield* Effect.either(runner.deploy({ name: "demo", ref: "main", stage: "main" }));
    expect(first._tag).toBe("Left");
    expect(state.candidateArtifact).toBe(true);
    expect(state.projects.get("demo")?.stages.main?.hash).toBe("old-hash");

    delete state.failSshCommand;
    delete state.healthError;
    yield* runWithTestClock(runner.deploy({ name: "demo", ref: "main", stage: "main" }));

    expect(state.calls.allocations).toEqual([3002, 3002]);
    expect(state.finalPort).toBe(3002);
    expect(state.candidateArtifact).toBe(false);
    expect(state.projects.get("demo")?.stages.main?.hash).toBe("hash-main");
    const cleanup = state.calls.ssh.findIndex(
      ({ command }) => command === "rm -rf /srv/projects/demo/stages/main.new",
    );
    const republish = state.calls.ssh.findIndex(
      ({ command }, index) =>
        index > cleanup && command === "mkdir -p /srv/projects/demo/stages/main.new",
    );
    expect(cleanup).toBeGreaterThanOrEqual(0);
    expect(republish).toBeGreaterThan(cleanup);
  });
});

it.effect("restarts a committed final after final start is interrupted", () => {
  const state = makeTestServices();
  state.nextPort = 3002;
  state.failSystemdStartUnit = "infra-demo-main";
  seedProject(state, "demo", { stages: { main: serviceStage() } });

  return Effect.gen(function* () {
    const runner = yield* runnerFromTestLayers(state);
    const first = yield* runWithTestClock(
      Effect.either(runner.deploy({ name: "demo", ref: "main", stage: "main" })),
      state.calls.trace,
    );
    expect(first._tag).toBe("Left");
    expect(state.candidateArtifact).toBe(false);
    expect(state.finalPort).toBe(3002);
    expect(state.finalActive).toBe(false);

    delete state.failSystemdStartUnit;
    yield* runner.deploy({ name: "demo", ref: "main", stage: "main" });

    expect(state.calls.allocations).toEqual([3002]);
    expect(state.calls.git.filter((call) => call.startsWith("addWorktree"))).toHaveLength(1);
    expect(state.calls.git.filter((call) => call.startsWith("removeWorktree"))).toHaveLength(0);
    expect(state.finalActive).toBe(true);
    expect(state.candidateArtifact).toBe(false);
    expect(state.candidateUnit).toBe(false);
    expect(state.projects.get("demo")?.stages.main?.hash).toBe("hash-main");
    expect(state.calls.trace.indexOf("caddy.sync")).toBeLessThan(
      state.calls.trace.indexOf("grace.sleep"),
    );
    expect(state.calls.trace.indexOf("grace.sleep")).toBeLessThan(
      state.calls.trace.indexOf("systemd.remove.infra-demo-main"),
    );
    expect(state.calls.trace.indexOf("systemd.remove.infra-demo-main")).toBeLessThan(
      state.calls.trace.indexOf("artifact.finalize"),
    );
    expect(
      state.calls.systemd.findIndex(
        ({ action, unit }) => action === "stop" && unit === "infra-demo-main",
      ),
    ).toBeLessThan(
      state.calls.systemd.findIndex(
        ({ action, unit }) => action === "install" && unit === "infra-demo-main",
      ),
    );
  });
});

it.effect("hands off a candidate when the old final unit is already absent", () => {
  const state = makeTestServices();
  seedProject(state, "demo", {
    stages: { main: { ...serviceStage(), hash: "hash-main", port: 3002 } },
  });
  state.finalPort = 3001;
  state.finalUnit = false;
  state.finalActive = false;
  state.candidateArtifact = true;
  state.candidatePort = 3002;
  state.candidateUnit = true;
  state.candidateWorkingDirectory = "/srv/projects/demo/stages/main.new";

  return Effect.gen(function* () {
    const runner = yield* runnerFromTestLayers(state);
    yield* runner.deploy({ name: "demo", ref: "main", stage: "main" });

    expect(state.calls.allocations).toEqual([]);
    expect(state.calls.git.filter((call) => call.startsWith("addWorktree"))).toHaveLength(0);
    expect(state.calls.git.filter((call) => call.startsWith("removeWorktree"))).toHaveLength(0);
    expect(state.finalActive).toBe(true);
    expect(state.candidateArtifact).toBe(false);
    expect(state.candidateUnit).toBe(false);
    expect(state.calls.trace).not.toContain("grace.sleep");
  });
});

it.effect("does not stop an inactive old final during handoff", () => {
  const state = makeTestServices();
  seedProject(state, "demo", {
    stages: { main: { ...serviceStage(), hash: "hash-main", port: 3002 } },
  });
  state.finalPort = 3001;
  state.finalActive = false;
  state.candidateArtifact = true;
  state.candidatePort = 3002;
  state.candidateUnit = true;
  state.candidateWorkingDirectory = "/srv/projects/demo/stages/main.new";

  return Effect.gen(function* () {
    const runner = yield* runnerFromTestLayers(state);
    yield* runner.deploy({ name: "demo", ref: "main", stage: "main" });

    expect(state.calls.systemd).not.toContainEqual({
      action: "stop",
      host: "test-host",
      unit: "infra-demo-main",
    });
    expect(state.calls.trace).not.toContain("grace.sleep");
    expect(state.finalActive).toBe(true);
  });
});

it.effect("recovers when artifact handoff is interrupted", () => {
  const state = makeTestServices();
  state.nextPort = 3002;
  state.failSshCommand = "if [ -e '/srv/projects/demo/stages/main.new'";
  seedProject(state, "demo", { stages: { main: serviceStage() } });

  return Effect.gen(function* () {
    const runner = yield* runnerFromTestLayers(state);
    const first = yield* runWithTestClock(
      Effect.either(runner.deploy({ name: "demo", ref: "main", stage: "main" })),
    );
    expect(first._tag).toBe("Left");
    expect(state.projects.get("demo")?.stages.main?.hash).toBe("hash-main");
    expect(state.candidateArtifact).toBe(true);

    delete state.failSshCommand;
    yield* runWithTestClock(runner.deploy({ name: "demo", ref: "main", stage: "main" }));
    expect(state.calls.allocations).toEqual([3002]);
    expect(state.candidateArtifact).toBe(false);
    expect(state.finalActive).toBe(true);
  });
});

it.effect("recovers when candidate unit removal is interrupted", () => {
  const state = makeTestServices();
  state.nextPort = 3002;
  state.failSystemdRemoveUnit = "infra-demo-main-new";
  seedProject(state, "demo", { stages: { main: serviceStage() } });

  return Effect.gen(function* () {
    const runner = yield* runnerFromTestLayers(state);
    const first = yield* runWithTestClock(
      Effect.either(runner.deploy({ name: "demo", ref: "main", stage: "main" })),
    );
    expect(first._tag).toBe("Left");
    expect(state.candidateArtifact).toBe(false);
    expect(state.candidateUnit).toBe(true);

    delete state.failSystemdRemoveUnit;
    yield* runner.deploy({ name: "demo", ref: "main", stage: "main" });
    expect(state.calls.allocations).toEqual([3002]);
    expect(state.candidateUnit).toBe(false);
    expect(state.finalActive).toBe(true);
  });
});

it.effect("does not treat an inspection failure as a committed handoff", () => {
  const state = makeTestServices();
  state.nextPort = 3002;
  state.failSshCommand = "candidatePort";
  seedProject(state, "demo", { stages: { main: serviceStage() } });

  return Effect.gen(function* () {
    const runner = yield* runnerFromTestLayers(state);
    const first = yield* Effect.either(runner.deploy({ name: "demo", ref: "main", stage: "main" }));
    expect(first._tag).toBe("Left");
    expect(state.projects.get("demo")?.stages.main?.hash).toBe("old-hash");
    expect(state.calls.allocations).toEqual([]);

    delete state.failSshCommand;
    yield* runWithTestClock(runner.deploy({ name: "demo", ref: "main", stage: "main" }));
    expect(state.calls.allocations).toEqual([3002]);
    expect(state.projects.get("demo")?.stages.main?.hash).toBe("hash-main");
    expect(state.finalActive).toBe(true);
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

it.effect("cleans a fresh service when metadata commit fails", () => {
  const state = makeTestServices();
  state.failMetaSave = true;

  return Effect.gen(function* () {
    const runner = yield* runnerFromTestLayers(state);
    const result = yield* Effect.either(
      runner.deploy({ name: "demo", ref: "main", stage: "main" }),
    );

    expect(result._tag).toBe("Left");
    if (result._tag === "Left") expect(result.left).toBeInstanceOf(DeployMetaError);
    expect(state.calls.systemd).toEqual([
      { action: "install", host: "test-host", unit: "infra-demo-main" },
      { action: "start", host: "test-host", unit: "infra-demo-main" },
      { action: "remove", host: "test-host", unit: "infra-demo-main" },
    ]);
    expect(state.calls.ssh).toContainEqual({
      host: "test-host",
      command: "rm -rf /srv/projects/demo/stages/main",
    });
    expect(state.projects.has("demo")).toBe(false);
  });
});
