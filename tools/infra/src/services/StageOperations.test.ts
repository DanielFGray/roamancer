import { expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { CaddyError } from "./CaddyManager.ts";
import { DeployMetaError } from "./DeployMeta.ts";
import { HealthCheckError } from "./HealthCheck.ts";
import { BuildError } from "./BuildRunner.ts";
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

it.effect("cleans only the worktree when the build fails before publication", () => {
  const state = makeTestServices();
  state.failBuild = "install";

  return Effect.gen(function* () {
    const runner = yield* runnerFromTestLayers(state);
    state.files.set(
      "/test/worktrees/demo/main/package.json",
      '{"scripts":{"build":"bun run build"},"infra":{"host":"test-host"}}',
    );
    const result = yield* Effect.either(
      runner.deploy({ name: "demo", ref: "main", stage: "main" }),
    );

    expect(result._tag).toBe("Left");
    if (result._tag === "Left") expect(result.left).toBeInstanceOf(BuildError);
    expect(state.calls.git).toContain("removeWorktree demo main");
    expect(state.calls.ssh).toEqual([]);
    expect(state.calls.systemd).toEqual([]);
  });
});

it.effect("removes a partial static publication", () => {
  const state = makeTestServices();
  state.failSshCommand = "rsync";

  return Effect.gen(function* () {
    const runner = yield* runnerFromTestLayers(state);
    state.files.set(
      "/test/worktrees/demo/main/package.json",
      '{"scripts":{"build":"bun run build"},"infra":{"host":"test-host"}}',
    );
    const result = yield* Effect.either(
      runner.deploy({ name: "demo", ref: "main", stage: "main" }),
    );

    expect(result._tag).toBe("Left");
    expect(state.calls.ssh).toContainEqual({
      host: "test-host",
      command: "rm -rf '/srv/www/demo/stages/main.new'",
    });
    expect(state.projects.has("demo")).toBe(false);
  });
});

it.effect("preserves an existing static deployment when candidate publication fails", () => {
  const state = makeTestServices();
  state.failSshCommand = "rsync";
  seedProject(state, "demo", {
    stages: {
      main: {
        type: "static",
        ref: "main",
        hash: "old-hash",
        port: null,
        host: "test-host",
        domain: "demo",
        deployed_at: "2026-01-01T00:00:00.000Z",
      },
    },
  });

  return Effect.gen(function* () {
    const runner = yield* runnerFromTestLayers(state);
    state.files.set(
      "/test/worktrees/demo/main/package.json",
      '{"scripts":{"build":"bun run build"},"infra":{"host":"test-host"}}',
    );
    const result = yield* Effect.either(
      runner.deploy({ name: "demo", ref: "main", stage: "main" }),
    );

    expect(result._tag).toBe("Left");
    expect(state.projects.get("demo")?.stages.main?.hash).toBe("old-hash");
    expect(state.calls.ssh).toContainEqual({
      host: "test-host",
      command: "rm -rf '/srv/www/demo/stages/main.new'",
    });
    expect(state.calls.ssh).not.toContainEqual({
      host: "test-host",
      command: "rm -rf '/srv/www/demo/stages/main'",
    });
  });
});

it.effect("preserves a fresh static deployment after metadata commit when Caddy sync fails", () => {
  const state = makeTestServices();
  state.failCaddySync = true;

  return Effect.gen(function* () {
    const runner = yield* runnerFromTestLayers(state);
    state.files.set(
      "/test/worktrees/demo/main/package.json",
      '{"scripts":{"build":"bun run build"},"infra":{"host":"test-host"}}',
    );
    const result = yield* Effect.either(
      runner.deploy({ name: "demo", ref: "main", stage: "main" }),
    );

    expect(result._tag).toBe("Left");
    if (result._tag === "Left") expect(result.left).toBeInstanceOf(CaddyError);
    expect(state.projects.get("demo")?.stages.main?.type).toBe("static");
    expect(state.calls.ssh.some(({ command }) => command.includes("if mv"))).toBe(true);
    expect(state.calls.ssh).not.toContainEqual({
      host: "test-host",
      command: "rm -rf '/srv/www/demo/stages/main'",
    });
  });
});

it.effect(
  "replaces an existing static deployment and removes its backup after metadata commit",
  () => {
    const state = makeTestServices();
    state.staticHadPrevious = true;
    seedProject(state, "demo", {
      stages: {
        main: {
          type: "static",
          ref: "old",
          hash: "old-hash",
          port: null,
          host: "test-host",
          domain: "demo",
          deployed_at: "2026-01-01T00:00:00.000Z",
        },
      },
    });

    return Effect.gen(function* () {
      const runner = yield* runnerFromTestLayers(state);
      state.files.set(
        "/test/worktrees/demo/main/package.json",
        '{"scripts":{"build":"bun run build"},"infra":{"host":"test-host"}}',
      );
      yield* runner.deploy({ name: "demo", ref: "main", stage: "main" });
      expect(state.projects.get("demo")?.stages.main?.hash).toBe("hash-main");
      expect(state.calls.ssh.at(-1)).toEqual({
        host: "test-host",
        command: "rm -rf '/srv/www/demo/stages/main.previous'",
      });
    });
  },
);

it.effect("rolls back the static activation when activation fails", () => {
  const state = makeTestServices();
  state.staticHadPrevious = true;
  state.failSshCommand = "if mv";
  seedProject(state, "demo", {
    stages: {
      main: {
        type: "static",
        ref: "old",
        hash: "old-hash",
        port: null,
        host: "test-host",
        domain: "demo",
        deployed_at: "2026-01-01T00:00:00.000Z",
      },
    },
  });

  return Effect.gen(function* () {
    const runner = yield* runnerFromTestLayers(state);
    state.files.set(
      "/test/worktrees/demo/main/package.json",
      '{"scripts":{"build":"bun run build"},"infra":{"host":"test-host"}}',
    );
    const result = yield* Effect.either(
      runner.deploy({ name: "demo", ref: "main", stage: "main" }),
    );
    expect(result._tag).toBe("Left");
    expect(state.projects.get("demo")?.stages.main?.hash).toBe("old-hash");
    expect(state.calls.ssh[2]?.command).toContain("mv '/srv/www/demo/stages/main.previous'");
    expect(
      state.calls.ssh.some(
        ({ command }) =>
          command.includes("/srv/www/demo/stages/main'") && command.includes("main.new"),
      ),
    ).toBe(true);
  });
});

it.effect("rolls back the static activation when metadata save fails", () => {
  const state = makeTestServices();
  state.staticHadPrevious = true;
  state.failMetaSave = true;
  seedProject(state, "demo", {
    stages: {
      main: {
        type: "static",
        ref: "old",
        hash: "old-hash",
        port: null,
        host: "test-host",
        domain: "demo",
        deployed_at: "2026-01-01T00:00:00.000Z",
      },
    },
  });

  return Effect.gen(function* () {
    const runner = yield* runnerFromTestLayers(state);
    state.files.set(
      "/test/worktrees/demo/main/package.json",
      '{"scripts":{"build":"bun run build"},"infra":{"host":"test-host"}}',
    );
    const result = yield* Effect.either(
      runner.deploy({ name: "demo", ref: "main", stage: "main" }),
    );
    expect(result._tag).toBe("Left");
    expect(state.projects.get("demo")?.stages.main?.hash).toBe("old-hash");
    expect(
      state.calls.ssh.some(({ command }) =>
        command.includes("mv '/srv/www/demo/stages/main.previous' '/srv/www/demo/stages/main'"),
      ),
    ).toBe(true);
    expect(
      state.calls.ssh.some(
        ({ command }) => command.includes("main.previous") && command.includes("main.new"),
      ),
    ).toBe(true);
  });
});

it.effect("removes a started service when its health check fails", () => {
  const state = makeTestServices();
  state.healthError = new HealthCheckError({ stage: "main", reason: "unhealthy" });

  return Effect.gen(function* () {
    const runner = yield* runnerFromTestLayers(state);
    const result = yield* Effect.either(
      runner.deploy({ name: "demo", ref: "main", stage: "main" }),
    );

    expect(result._tag).toBe("Left");
    if (result._tag === "Left") expect(result.left).toBeInstanceOf(HealthCheckError);
    expect(state.calls.systemd).toEqual([
      { action: "install", host: "test-host", unit: "infra-demo-main" },
      { action: "start", host: "test-host", unit: "infra-demo-main" },
      { action: "remove", host: "test-host", unit: "infra-demo-main" },
    ]);
    expect(state.projects.has("demo")).toBe(false);
  });
});

it.effect("retains metadata when teardown cleanup fails and completes on retry", () => {
  const state = makeTestServices();
  state.failSshCommand = "/srv/projects/demo/stages/main";
  seedProject(state, "demo", { stages: { main: serviceStage(), next: serviceStage() } });

  return Effect.gen(function* () {
    const runner = yield* runnerFromTestLayers(state);
    const result = yield* Effect.either(runner.teardown({ name: "demo", stage: "main" }));
    expect(result._tag).toBe("Left");
    if (result._tag === "Left") expect(result.left).toBeInstanceOf(SshError);
    expect(state.projects.get("demo")?.stages.main).toBeDefined();
    delete state.failSshCommand;
    yield* runner.teardown({ name: "demo", stage: "main" });
    expect(Object.keys(state.projects.get("demo")?.stages ?? {})).toEqual(["next"]);
  });
});

it.effect("teardown saves remaining stages and removes static resources", () => {
  const state = makeTestServices();
  seedProject(state, "demo", {
    stages: {
      main: {
        type: "static",
        ref: "main",
        hash: "hash-main",
        port: null,
        host: "test-host",
        domain: "demo",
        deployed_at: "2026-01-01T00:00:00.000Z",
      },
      next: serviceStage(),
    },
  });

  return Effect.gen(function* () {
    const runner = yield* runnerFromTestLayers(state);
    yield* runner.teardown({ name: "demo", stage: "main" });
    expect(Object.keys(state.projects.get("demo")?.stages ?? {})).toEqual(["next"]);
    expect(state.calls.ssh).toContainEqual({
      host: "test-host",
      command: "rm -rf '/srv/www/demo/stages/main'",
    });
  });
});

it.effect("removes abandoned service candidates before the live final resource", () => {
  const state = makeTestServices();
  state.failSshCommand = "/srv/projects/demo/stages/main.new";
  seedProject(state, "demo", { stages: { main: serviceStage(), next: serviceStage() } });

  return Effect.gen(function* () {
    const runner = yield* runnerFromTestLayers(state);
    const result = yield* Effect.either(runner.teardown({ name: "demo", stage: "main" }));
    expect(result._tag).toBe("Left");
    expect(state.calls.systemd).not.toContainEqual({
      action: "remove",
      host: "test-host",
      unit: "infra-demo-main",
    });
    expect(state.calls.ssh).toEqual([
      { host: "test-host", command: "rm -rf /srv/projects/demo/stages/main.new" },
    ]);
  });
});

it.effect("does not remove the last stage when project deletion fails", () => {
  const state = makeTestServices();
  state.failMetaDelete = true;
  seedProject(state, "demo", { stages: { main: serviceStage() } });

  return Effect.gen(function* () {
    const runner = yield* runnerFromTestLayers(state);
    const result = yield* Effect.either(runner.teardown({ name: "demo", stage: "main" }));
    expect(result._tag).toBe("Left");
    if (result._tag === "Left") expect(result.left).toBeInstanceOf(DeployMetaError);
    expect(state.projects.has("demo")).toBe(true);
    expect(state.calls.ssh).toContainEqual({
      host: "test-host",
      command: "rm -rf /srv/projects/demo/stages/main",
    });
    state.failMetaDelete = false;
    yield* runner.teardown({ name: "demo", stage: "main" });
    expect(state.projects.has("demo")).toBe(false);
  });
});

it.effect("keeps committed teardown state when Caddy sync fails", () => {
  const state = makeTestServices();
  state.failCaddySync = true;
  seedProject(state, "demo", { stages: { main: serviceStage() } });

  return Effect.gen(function* () {
    const runner = yield* runnerFromTestLayers(state);
    const result = yield* Effect.either(runner.teardown({ name: "demo", stage: "main" }));
    expect(result._tag).toBe("Left");
    if (result._tag === "Left") expect(result.left).toBeInstanceOf(CaddyError);
    expect(state.projects.has("demo")).toBe(false);
  });
});
