import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import * as BunServices from "@effect/platform-bun/BunServices";
import { ConfigProvider, Effect, Fiber, Layer, Option } from "effect";
import { request } from "./Client.ts";
import { finished } from "./Finished.ts";
import { under, type Paths } from "./Paths.ts";
import { decodeRequest } from "./Protocol.ts";
import { runJob } from "./Run.ts";
import { stageOf, unitName } from "./Schema.ts";
import { layerServer, recover, serve } from "./Serve.ts";
import { tryStart } from "./Starter.ts";
import { layer as storeLayer, Store } from "./Store.ts";
import { Units } from "./Units.ts";

const tempRoot = (): { root: string; paths: Paths } => {
  const root = mkdtempSync(join(tmpdir(), "alchemy-queue-"));
  return { root, paths: under(root) };
};

const stageSubmit = {
  _tag: "submit" as const,
  command: "plan" as const,
  stage: "shop",
  cartridge: '{"name":"shop"}',
  origin: "origin-a",
  revision: "rev-1",
};

const fakeUnits = (options?: {
  readonly active?: Set<number>;
  readonly starts?: Array<number>;
}) => {
  const active = options?.active ?? new Set<number>();
  const starts = options?.starts ?? [];
  return {
    active,
    starts,
    layer: Layer.succeed(
      Units,
      Units.of({
        start: (id: number) =>
          Effect.sync(() => {
            starts.push(id);
            active.add(id);
          }),
        isActive: (id: number) => Effect.succeed(active.has(id)),
      }),
    ),
  };
};

const storeUnits = (paths: Paths, units: Layer.Layer<Units>) =>
  Layer.mergeAll(storeLayer(paths.database), units).pipe(Layer.provideMerge(BunServices.layer));

const withStore = <A, E>(
  paths: Paths,
  units: Layer.Layer<Units>,
  effect: Effect.Effect<A, E, Store | Units>,
) => Effect.runPromise(effect.pipe(Effect.provide(storeUnits(paths, units))));

const runServe = (paths: Paths, units: Layer.Layer<Units>) => {
  const program = serve(paths).pipe(
    Effect.provide(layerServer(paths)),
    Effect.provide(storeUnits(paths, units)),
    Effect.provide(BunServices.layer),
  );
  const fiber = Effect.runFork(program as Effect.Effect<void, unknown>);
  return {
    stop: () => Effect.runPromise(Fiber.interrupt(fiber)),
  };
};

describe("queue store", () => {
  it("migrates on open and records state changes", async () => {
    const { root, paths } = tempRoot();
    try {
      await withStore(
        paths,
        fakeUnits().layer,
        Effect.gen(function* () {
          const store = yield* Store;
          const first = yield* store.enqueue({
            command: "deploy",
            stage: "shop",
            cartridge: "{}",
            origin: "o",
            revision: "r",
          });
          assert.equal(first.id, 1);
          assert.equal(first.state, "queued");
          const reserved = yield* store.reserveNext();
          assert.equal(Option.getOrThrow(reserved).state, "starting");
          yield* store.claim(1);
          assert.equal((yield* store.get(1)).state, "running");
          yield* store.finish(1, 0);
          const done = yield* store.get(1);
          assert.equal(done.state, "succeeded");
          assert.equal(done.exitCode, 0);
        }),
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("refuses cancel of a running job", async () => {
    const { root, paths } = tempRoot();
    try {
      await withStore(
        paths,
        fakeUnits().layer,
        Effect.gen(function* () {
          const store = yield* Store;
          const job = yield* store.enqueue({
            command: "plan",
            stage: "shop",
            cartridge: null,
            origin: "",
            revision: "",
          });
          yield* store.reserveNext();
          yield* store.claim(job.id);
          const error = yield* Effect.flip(store.cancel(job.id));
          assert.equal(error._tag, "CancelRefused");
        }),
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("queue protocol", () => {
  it("rejects invalid requests and free args", () => {
    assert.throws(() => decodeRequest({ _tag: "submit" }));
    assert.throws(() => decodeRequest({ _tag: "show", id: "nope" }));
    assert.throws(() => decodeRequest({ _tag: "token" }));
    assert.throws(() =>
      decodeRequest({
        _tag: "submit",
        command: "plan",
        args: ["-c", "evil.ts"],
        cartridge: null,
        origin: "",
        revision: "",
      }),
    );
    assert.deepEqual(decodeRequest({ _tag: "list" }), { _tag: "list" });
    const submitted = decodeRequest({
      _tag: "submit",
      command: "plan",
      stage: "shop",
      cartridge: null,
      origin: "",
      revision: "",
    });
    assert.equal(submitted._tag, "submit");
    if (submitted._tag === "submit") assert.equal(submitted.command, "plan");
  });
});

describe("queue starter", () => {
  it("never starts a second job while one is reserved or running", async () => {
    const { root, paths } = tempRoot();
    const fake = fakeUnits();
    try {
      await withStore(
        paths,
        fake.layer,
        Effect.gen(function* () {
          const store = yield* Store;
          yield* store.enqueue({
            command: "plan",
            stage: "a",
            cartridge: null,
            origin: "",
            revision: "",
          });
          yield* store.enqueue({
            command: "plan",
            stage: "b",
            cartridge: null,
            origin: "",
            revision: "",
          });
          assert.deepEqual(yield* tryStart(), Option.some(1));
          assert.deepEqual(fake.starts, [1]);
          assert.deepEqual(yield* tryStart(), Option.none());
          assert.deepEqual(fake.starts, [1]);
          yield* store.claim(1);
          assert.deepEqual(yield* tryStart(), Option.none());
          assert.deepEqual(fake.starts, [1]);
        }),
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("atomic reserve excludes concurrent starters without unit state", async () => {
    const { root, paths } = tempRoot();
    try {
      await withStore(
        paths,
        fakeUnits().layer,
        Effect.gen(function* () {
          const store = yield* Store;
          yield* store.enqueue({
            command: "plan",
            stage: "a",
            cartridge: null,
            origin: "",
            revision: "",
          });
          yield* store.enqueue({
            command: "plan",
            stage: "b",
            cartridge: null,
            origin: "",
            revision: "",
          });
          const first = yield* store.reserveNext();
          const second = yield* store.reserveNext();
          assert.equal(Option.getOrThrow(first).id, 1);
          assert.equal(Option.isNone(second), true);
          assert.equal((yield* store.get(1)).state, "starting");
          assert.equal((yield* store.get(2)).state, "queued");
        }),
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("queue crash recovery", () => {
  it("leaves queued rows alone after a crash before start", async () => {
    const { root, paths } = tempRoot();
    try {
      await withStore(
        paths,
        fakeUnits().layer,
        Effect.gen(function* () {
          const store = yield* Store;
          yield* store.enqueue({
            command: "deploy",
            stage: "shop",
            cartridge: "{}",
            origin: "o",
            revision: "r",
          });
          yield* recover();
          const jobs = yield* store.list();
          assert.deepEqual(
            jobs.map((job) => job.state),
            ["queued"],
          );
          assert.equal(jobs.length, 1);
        }),
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("marks a running job interrupted and queues a plan for the same stage", async () => {
    const { root, paths } = tempRoot();
    try {
      await withStore(
        paths,
        fakeUnits().layer,
        Effect.gen(function* () {
          const store = yield* Store;
          const job = yield* store.enqueue({
            command: "deploy",
            stage: "shop",
            cartridge: "{}",
            origin: "o",
            revision: "r",
          });
          yield* store.reserveNext();
          yield* store.claim(job.id);
          yield* recover();
          const jobs = yield* store.list();
          const interrupted = jobs.find((row) => row.id === job.id);
          const plan = jobs.find((row) => row.submit.command === "plan" && row.state === "queued");
          assert.equal(interrupted?.state, "interrupted");
          assert.ok(plan !== undefined);
          if (plan?.submit.command === "plan") {
            assert.equal(plan.submit.stage, "shop");
          }
        }),
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("queue cancel race", () => {
  it("canceled starting row fails claim so Alchemy never runs", async () => {
    const { root, paths } = tempRoot();
    try {
      await withStore(
        paths,
        fakeUnits().layer,
        Effect.gen(function* () {
          const store = yield* Store;
          const job = yield* store.enqueue({
            command: "deploy",
            stage: "shop",
            cartridge: "{}",
            origin: "o",
            revision: "r",
          });
          yield* store.reserveNext();
          yield* store.cancel(job.id);
          const error = yield* Effect.flip(store.claim(job.id));
          assert.equal(error._tag, "JobNotStarting");
          assert.equal((yield* store.get(job.id)).state, "canceled");
        }),
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("queue socket", () => {
  it("gives two ids for duplicate submits and cancels only queued jobs", async () => {
    const { root, paths } = tempRoot();
    const fake = fakeUnits();
    const server = runServe(paths, fake.layer);
    try {
      await delay(80);
      const a = await Effect.runPromise(request(paths.socket, stageSubmit));
      const b = await Effect.runPromise(request(paths.socket, stageSubmit));
      assert.deepEqual(a, { _tag: "submitted", id: 1 });
      assert.deepEqual(b, { _tag: "submitted", id: 2 });
      assert.deepEqual(fake.starts, [1]);

      const listed = await Effect.runPromise(request(paths.socket, { _tag: "list" }));
      assert.equal(listed._tag, "listed");
      if (listed._tag === "listed") assert.equal(listed.jobs.length, 2);

      const shown = await Effect.runPromise(request(paths.socket, { _tag: "show", id: 1 }));
      assert.equal(shown._tag, "shown");
      if (shown._tag === "shown") assert.equal(shown.unit, unitName(1));

      await withStore(
        paths,
        fake.layer,
        Effect.gen(function* () {
          yield* (yield* Store).claim(1);
        }),
      );
      const refused = await Effect.runPromise(request(paths.socket, { _tag: "cancel", id: 1 }));
      assert.equal(refused._tag, "error");

      const canceled = await Effect.runPromise(request(paths.socket, { _tag: "cancel", id: 2 }));
      assert.equal(canceled._tag, "canceled");

      const token = await Effect.runPromise(
        request(paths.socket, { _tag: "token", value: "minted-token" }),
      );
      assert.deepEqual(token, { _tag: "tokenStored" });
      assert.equal(readFileSync(paths.tokenFile, "utf8"), "minted-token");
    } finally {
      await server.stop();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("wait returns when the job ends", async () => {
    const { root, paths } = tempRoot();
    const fake = fakeUnits();
    const server = runServe(paths, fake.layer);
    try {
      await delay(80);
      const submitted = await Effect.runPromise(request(paths.socket, stageSubmit));
      assert.equal(submitted._tag, "submitted");
      if (submitted._tag !== "submitted") return;

      const waiting = Effect.runPromise(request(paths.socket, { _tag: "wait", id: submitted.id }));
      await delay(80);
      await withStore(
        paths,
        fake.layer,
        Effect.gen(function* () {
          const store = yield* Store;
          yield* store.claim(submitted.id);
          yield* store.finish(submitted.id, 0);
        }),
      );
      const waited = await waiting;
      assert.deepEqual(waited, {
        _tag: "waited",
        id: submitted.id,
        state: "succeeded",
        exitCode: 0,
      });
    } finally {
      await server.stop();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("token write is atomic rename to the final path", async () => {
    const { root, paths } = tempRoot();
    const fake = fakeUnits();
    const server = runServe(paths, fake.layer);
    try {
      await delay(80);
      writeFileSync(paths.tokenFile, "stale", { mode: 0o600 });
      await Effect.runPromise(request(paths.socket, { _tag: "token", value: "fresh-token" }));
      assert.equal(readFileSync(paths.tokenFile, "utf8"), "fresh-token");
    } finally {
      await server.stop();
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("queue stop hook", () => {
  it("missing token marks the job failed and the next job starts", async () => {
    const { root, paths } = tempRoot();
    const fake = fakeUnits();
    const server = runServe(paths, fake.layer);
    try {
      await delay(80);
      await Effect.runPromise(request(paths.socket, stageSubmit));
      await Effect.runPromise(request(paths.socket, { ...stageSubmit, stage: "other" }));
      assert.deepEqual(fake.starts, [1]);

      const error = await Effect.runPromise(
        runJob(1, paths, () => Effect.void).pipe(
          Effect.flip,
          Effect.provide(storeLayer(paths.database)),
          Effect.provide(BunServices.layer),
        ),
      );
      assert.equal(error._tag, "LoginRequired");

      fake.active.delete(1);
      await Effect.runPromise(
        finished(1, paths).pipe(
          Effect.provide(storeUnits(paths, fake.layer)),
          Effect.provide(BunServices.layer),
        ),
      );
      assert.deepEqual(fake.starts, [1, 2]);

      const listed = await Effect.runPromise(request(paths.socket, { _tag: "list" }));
      assert.equal(listed._tag, "listed");
      if (listed._tag === "listed") {
        assert.equal(listed.jobs.find((j) => j.id === 1)?.state, "failed");
        assert.equal(listed.jobs.find((j) => j.id === 2)?.state, "starting");
      }
    } finally {
      await server.stop();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("a killed running job is reported by the stop hook", async () => {
    const { root, paths } = tempRoot();
    const fake = fakeUnits();
    const server = runServe(paths, fake.layer);
    try {
      await delay(80);
      await Effect.runPromise(request(paths.socket, stageSubmit));
      await Effect.runPromise(request(paths.socket, { ...stageSubmit, stage: "other" }));
      assert.deepEqual(fake.starts, [1]);

      await withStore(
        paths,
        fake.layer,
        Effect.gen(function* () {
          yield* (yield* Store).claim(1);
        }),
      );

      fake.active.delete(1);
      await Effect.runPromise(
        finished(1, paths).pipe(
          Effect.provide(storeUnits(paths, fake.layer)),
          Effect.provide(BunServices.layer),
          Effect.provide(
            ConfigProvider.layer(ConfigProvider.fromEnvRecord({ SERVICE_RESULT: "signal" })),
          ),
        ),
      );

      const listed = await Effect.runPromise(request(paths.socket, { _tag: "list" }));
      assert.equal(listed._tag, "listed");
      if (listed._tag === "listed") {
        assert.equal(listed.jobs.find((j) => j.id === 1)?.state, "interrupted");
        assert.equal(listed.jobs.find((j) => j.id === 2)?.state, "starting");
      }
      assert.deepEqual(fake.starts, [1, 2]);
    } finally {
      await server.stop();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("failed next from finished is not swallowed", async () => {
    const { root, paths } = tempRoot();
    try {
      await withStore(
        paths,
        fakeUnits().layer,
        Effect.gen(function* () {
          const store = yield* Store;
          const job = yield* store.enqueue({
            command: "plan",
            stage: "shop",
            cartridge: null,
            origin: "",
            revision: "",
          });
          yield* store.reserveNext();
          yield* store.claim(job.id);
          const error = yield* Effect.flip(finished(job.id, paths));
          assert.ok(error._tag !== undefined);
        }),
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("stageOf", () => {
  it("reads stage from structured submit", () => {
    assert.equal(
      stageOf({ command: "plan", stage: "shop", cartridge: null, origin: "", revision: "" }),
      "shop",
    );
    assert.equal(stageOf({ command: "rollback", name: "shop", deploymentId: 3 }), "shop");
  });
});
