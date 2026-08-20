import { expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { CaddyManager } from "./CaddyManager.ts";
import { DeployMeta } from "./DeployMeta.ts";
import { HealthCheck, HealthCheckError } from "./HealthCheck.ts";
import {
  makePromotionService,
  NothingToRollbackError,
  StageNotFoundError,
} from "./PromotionService.ts";
import { makeTestServices, seedProject, testLayers } from "../test/layers.ts";

const stage = (domain: string) => ({
  type: "service" as const,
  ref: "main",
  hash: "abc123",
  port: 3001,
  host: "test-host",
  domain,
  deployed_at: "2026-01-01T00:00:00.000Z",
});

const promotionFromContext = Effect.gen(function* () {
  return makePromotionService(yield* DeployMeta, yield* CaddyManager, yield* HealthCheck);
});

it.effect("promotes after health, then saves metadata and syncs Caddy", () => {
  const state = makeTestServices();
  seedProject(state, "demo", {
    stages: { main: stage("demo.example"), next: stage("next.example") },
  });

  return Effect.gen(function* () {
    const promotion = yield* promotionFromContext;
    const result = yield* promotion.promote({ name: "demo", stage: "next" });

    expect(result).toEqual({ name: "demo", stage: "next", domain: "next.example" });
    expect(state.projects.get("demo")?.promoted).toBe("next");
    expect(state.calls.events).toEqual(["health.check:next", "metadata.save", "caddy.sync"]);
  }).pipe(Effect.provide(testLayers(state)));
});

it.effect("force promotion skips the health check", () => {
  const state = makeTestServices();
  seedProject(state, "demo", { stages: { main: stage("demo.example") } });

  return Effect.gen(function* () {
    const promotion = yield* promotionFromContext;
    yield* promotion.promote({ name: "demo", stage: "main", force: true });

    expect(state.calls.events).toEqual(["metadata.save", "caddy.sync"]);
  }).pipe(Effect.provide(testLayers(state)));
});

it.effect("preserves the health error and does not update metadata", () => {
  const state = makeTestServices();
  state.healthError = new HealthCheckError({ stage: "main", reason: "unhealthy" });
  seedProject(state, "demo", { stages: { main: stage("demo.example") } });

  return Effect.gen(function* () {
    const promotion = yield* promotionFromContext;
    const result = yield* Effect.either(promotion.promote({ name: "demo", stage: "main" }));
    const error = result._tag === "Left" ? result.left : undefined;

    expect(error).toBeInstanceOf(HealthCheckError);
    expect(error).toMatchObject({ stage: "main", reason: "unhealthy" });
    expect(state.projects.get("demo")?.promoted).toBeNull();
    expect(state.calls.events).toEqual(["health.check:main"]);
  }).pipe(Effect.provide(testLayers(state)));
});

it.effect("reports a missing promotion stage without syncing", () => {
  const state = makeTestServices();
  seedProject(state, "demo", { stages: { main: stage("demo.example") } });

  return Effect.gen(function* () {
    const promotion = yield* promotionFromContext;
    const result = yield* Effect.either(promotion.promote({ name: "demo", stage: "missing" }));
    const error = result._tag === "Left" ? result.left : undefined;

    expect(error).toBeInstanceOf(StageNotFoundError);
    expect(error).toMatchObject({ name: "demo", stage: "missing" });
    expect(state.calls.events).toEqual([]);
  }).pipe(Effect.provide(testLayers(state)));
});

it.effect("rejects rollback when there is no previous promotion", () => {
  const state = makeTestServices();
  seedProject(state, "demo", { stages: { main: stage("demo.example") } });

  return Effect.gen(function* () {
    const promotion = yield* promotionFromContext;
    const result = yield* Effect.either(promotion.rollback({ name: "demo" }));
    const error = result._tag === "Left" ? result.left : undefined;

    expect(error).toBeInstanceOf(NothingToRollbackError);
    expect(error).toMatchObject({ name: "demo" });
    expect(state.calls.events).toEqual([]);
  }).pipe(Effect.provide(testLayers(state)));
});

it.effect("rejects rollback when the previous stage is missing", () => {
  const state = makeTestServices();
  seedProject(state, "demo", {
    promoted: "next",
    promoted_previous: "missing",
    stages: { next: stage("next.example") },
  });

  return Effect.gen(function* () {
    const promotion = yield* promotionFromContext;
    const result = yield* Effect.either(promotion.rollback({ name: "demo" }));
    const error = result._tag === "Left" ? result.left : undefined;

    expect(error).toBeInstanceOf(StageNotFoundError);
    expect(error).toMatchObject({ name: "demo", stage: "missing" });
    expect(state.calls.events).toEqual([]);
  }).pipe(Effect.provide(testLayers(state)));
});

it.effect("rolls back metadata and syncs Caddy without a health check", () => {
  const state = makeTestServices();
  seedProject(state, "demo", {
    promoted: "next",
    promoted_previous: "main",
    stages: { main: stage("demo.example"), next: stage("next.example") },
  });

  return Effect.gen(function* () {
    const promotion = yield* promotionFromContext;
    const result = yield* promotion.rollback({ name: "demo" });

    expect(result).toEqual({ name: "demo", stage: "main" });
    expect(state.projects.get("demo")).toMatchObject({
      promoted: "main",
      promoted_previous: "next",
    });
    expect(state.calls.events).toEqual(["metadata.save", "caddy.sync"]);
  }).pipe(Effect.provide(testLayers(state)));
});
