import { expect, it } from "@effect/vitest";
import { HttpApiBuilder, HttpServer } from "@effect/platform";
import * as FileSystem from "@effect/platform/FileSystem";
import * as Path from "@effect/platform/Path";
import { AgentSecrets } from "../../server/secrets.ts";
import { BackupStatusLive } from "../../server/scheduler.ts";
import { Duration, Effect, Fiber, Layer, Schema as S, TestClock } from "effect";
import {
  makeOperationalReport,
  OperationalReportSchema,
  OperationalReportService,
} from "./OperationalReport.ts";
import { deploymentNames } from "../lib/deployment.ts";
import { CADDY_SITES_DIR } from "../lib/config.ts";
import { CaddyManager, CaddyReload, makeCaddyManager } from "./CaddyManager.ts";
import { DeployMeta } from "./DeployMeta.ts";
import {
  deployRunnerLayerFromTestLayers,
  deploymentComponentsFromTestLayers,
  runnerFromTestLayers,
} from "../test/deploy-runner-harness.ts";
import { makeTestServices, seedProject, testLayers } from "../test/layers.ts";
import { InfraApiLive } from "../../server/main.ts";

const serviceStage = () => ({
  type: "service" as const,
  ref: "main",
  hash: "old-hash",
  port: 3001,
  host: "test-host",
  domain: "demo",
  deployed_at: "2026-01-01T00:00:00.000Z",
});

const indexAfter = (events: ReadonlyArray<string>, event: string, after = -1) =>
  events.findIndex((value, index) => index > after && value === event);

it.effect("composes static publication, metadata, runtime artifact, and route ownership", () => {
  const state = makeTestServices();
  const custom = `${CADDY_SITES_DIR}/custom.caddyfile`;
  const stale = `${CADDY_SITES_DIR}/infra--stale.caddyfile`;
  state.files.set(custom, "owned elsewhere");
  state.files.set(stale, "stale managed route");
  const reload = Layer.succeed(CaddyReload, {
    _tag: "infra/CaddyReload" as const,
    reload: () =>
      Effect.sync(() => {
        state.calls.events.push("caddy.reload");
      }).pipe(Effect.as(undefined)),
  });
  const caddy = Layer.effect(
    CaddyManager,
    Effect.gen(function* () {
      return makeCaddyManager(
        yield* DeployMeta,
        yield* FileSystem.FileSystem,
        yield* Path.Path,
        yield* CaddyReload,
      );
    }),
  ).pipe(Layer.provide(Layer.mergeAll(testLayers(state), reload)));

  return Effect.gen(function* () {
    const runner = yield* runnerFromTestLayers(state, caddy);
    state.files.set(
      "/test/worktrees/demo/main/package.json",
      '{"scripts":{"build":"bun run build"},"infra":{"host":"test-host"}}',
    );
    const result = yield* runner.deploy({ name: "demo", ref: "main", stage: "main" });

    expect(result.type).toBe("static");
    expect(state.projects.get("demo")?.stages.main).toMatchObject({
      type: "static",
      hash: "hash-main",
    });
    expect(state.staticFinalArtifact).toBe(true);
    expect(state.staticCandidateArtifact).toBe(false);
    expect(state.calls.events).toEqual(["metadata.save", "caddy.reload"]);
    expect(state.files.get(custom)).toBe("owned elsewhere");
    expect(state.files.has(stale)).toBe(false);
    expect(
      state.files.get(`${CADDY_SITES_DIR}/${deploymentNames("demo", "main").stageSnippet}`),
    ).toContain("hash-main-preview.demo");
  });
});

it.effect("orders a rolling handoff across acquire, commit, finalize, and convergence", () => {
  const state = makeTestServices();
  state.nextPort = 3002;
  seedProject(state, "demo", { stages: { main: serviceStage() } });

  return Effect.gen(function* () {
    const runner = yield* runnerFromTestLayers(state);
    const fiber = yield* runner
      .deploy({ name: "demo", ref: "main", stage: "main" })
      .pipe(Effect.fork);
    yield* TestClock.adjust(Duration.seconds(30));
    yield* Fiber.join(fiber);

    const trace = state.calls.trace;
    const acquireInstall = indexAfter(trace, "systemd.install.infra-demo-main-new");
    const acquireStart = indexAfter(trace, "systemd.start.infra-demo-main-new", acquireInstall);
    const health = indexAfter(trace, "health.check:main", acquireStart);
    const sync = indexAfter(trace, "caddy.sync", health);
    const retire = indexAfter(trace, "systemd.stop.infra-demo-main", sync);
    const remove = indexAfter(trace, "systemd.remove.infra-demo-main", retire);
    const finalize = indexAfter(trace, "artifact.finalize", remove);
    const finalInstall = indexAfter(trace, "systemd.install.infra-demo-main", finalize);
    const finalStart = indexAfter(trace, "systemd.start.infra-demo-main", finalInstall);

    expect(acquireInstall).toBeGreaterThanOrEqual(0);
    expect(acquireStart).toBeGreaterThan(acquireInstall);
    expect(health).toBeGreaterThan(acquireStart);
    expect(sync).toBeGreaterThan(health);
    expect(retire).toBeGreaterThan(sync);
    expect(remove).toBeGreaterThan(retire);
    expect(finalize).toBeGreaterThan(remove);
    expect(finalInstall).toBeGreaterThan(finalize);
    expect(finalStart).toBeGreaterThan(finalInstall);
    expect(state.projects.get("demo")?.stages.main?.port).toBe(3002);
    expect(state.finalPort).toBe(3002);
    expect(state.finalActive).toBe(true);
    expect(state.candidateArtifact).toBe(false);
    expect(state.candidateUnit).toBe(false);
  });
});

it.effect("composes promotion and rollback through the project lock", () => {
  const state = makeTestServices();
  seedProject(state, "demo", {
    promoted: "main",
    stages: { main: serviceStage(), next: { ...serviceStage(), domain: "next.example" } },
  });

  return Effect.gen(function* () {
    const runner = yield* runnerFromTestLayers(state);
    yield* runner.promote({ name: "demo", stage: "next" });
    expect(state.projects.get("demo")).toMatchObject({
      promoted: "next",
      promoted_previous: "main",
    });
    yield* runner.rollback({ name: "demo" });
    expect(state.projects.get("demo")).toMatchObject({
      promoted: "main",
      promoted_previous: "next",
    });
    expect(state.calls.events).toEqual([
      "health.check:next",
      "metadata.save",
      "caddy.sync",
      "metadata.save",
      "caddy.sync",
    ]);
  });
});

it.effect("rejects missing and invalid auth and decodes an authenticated status report", () => {
  const state = makeTestServices();
  const runnerLayer = deployRunnerLayerFromTestLayers(state);
  const reportLayer = Layer.effect(
    OperationalReportService,
    makeOperationalReport.pipe(
      Effect.map(
        (value) =>
          Object.assign(value, {
            _tag: "infra/OperationalReport" as const,
          }) as OperationalReportService,
      ),
    ),
  ).pipe(Layer.provide(deploymentComponentsFromTestLayers(state)));
  const apiLayer = InfraApiLive.pipe(
    Layer.provide(runnerLayer),
    Layer.provide(reportLayer),
    Layer.provide(testLayers(state)),
    Layer.provide(BackupStatusLive),
    Layer.provide(Layer.succeed(AgentSecrets, { apiToken: "secret", webhookSecret: undefined })),
  );
  const api = HttpApiBuilder.toWebHandler(Layer.mergeAll(apiLayer, HttpServer.layerContext));

  return Effect.gen(function* () {
    const missing = yield* Effect.promise(() =>
      api.handler(new Request("http://infra.test/status")),
    );
    expect(missing.status).toBe(401);
    const invalid = yield* Effect.promise(() =>
      api.handler(
        new Request("http://infra.test/status", { headers: { authorization: "Bearer wrong" } }),
      ),
    );
    expect(invalid.status).toBe(401);
    const valid = yield* Effect.promise(() =>
      api.handler(
        new Request("http://infra.test/status", { headers: { authorization: "Bearer secret" } }),
      ),
    );
    expect(valid.status).toBe(200);
    const report = yield* Effect.promise(() => valid.json());
    const decoded = yield* S.decodeUnknown(OperationalReportSchema)(report);
    expect(decoded).toEqual(report);
  }).pipe(
    Effect.provide(TestClock.defaultTestClock),
    Effect.ensuring(Effect.promise(() => api.dispose())),
  );
});
