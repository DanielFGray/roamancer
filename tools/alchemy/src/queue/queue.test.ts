import { describe, it } from "node:test";
import { spawnSync } from "node:child_process";
import * as assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import * as BunServices from "@effect/platform-bun/BunServices";
import {
  ConfigProvider,
  Effect,
  Fiber,
  FileSystem as FileSystemModule,
  Layer,
  Option,
  Schedule,
  Sink,
  Stream,
} from "effect";
import { ChildProcess } from "effect/process";
import * as Spawner from "effect/process/ChildProcessSpawner";
import { request } from "./Client.ts";
import { finished } from "./Finished.ts";
import { spoolFile, under, type Paths } from "./Paths.ts";
import { decodeRequest } from "./Protocol.ts";
import { runJob } from "./Run.ts";
import { unitName } from "./Schema.ts";
import { layerServer, recover, serve, sweepSpool } from "./Serve.ts";
import { tryStart } from "./Starter.ts";
import { layer as storeLayer, Store } from "./Store.ts";
import { submitJob, waitJob } from "./Submit.ts";
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
  stagedImage: null,
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
  effect: Effect.Effect<A, E, Store | Units | FileSystemModule.FileSystem>,
) => Effect.runPromise(effect.pipe(Effect.provide(storeUnits(paths, units))));

const runServe = async (paths: Paths, units: Layer.Layer<Units>) => {
  const program = serve(paths).pipe(
    Effect.provide(layerServer(paths)),
    Effect.provide(storeUnits(paths, units)),
    Effect.provide(BunServices.layer),
  );
  const fiber = Effect.runFork(program as Effect.Effect<void, unknown>);
  // Startup time varies, so wait until the socket answers instead of sleeping.
  await Effect.runPromise(
    request(paths.socket, { _tag: "list" }).pipe(
      Effect.retry({ schedule: Schedule.spaced("10 millis"), times: 200 }),
    ),
  );
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
            command: "plan",
            stage: "shop",
            cartridge: "{}",
            origin: "o",
            revision: "r",
            stagedImage: null,
          });
          assert.equal(first.id, 1);
          assert.equal(first.state, "queued");
          const reserved = yield* store.reserveNext();
          assert.equal(Option.getOrThrow(reserved).state, "starting");
          yield* store.claim(1, null);
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
            stagedImage: null,
          });
          yield* store.reserveNext();
          yield* store.claim(job.id, null);
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
        stagedImage: null,
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
      stagedImage: null,
    });
    assert.equal(submitted._tag, "submit");
    if (submitted._tag === "submit") assert.equal(submitted.command, "plan");
    assert.throws(() =>
      decodeRequest({
        _tag: "signoff",
        app: "shop",
        tree: "not-a-tree",
        commit: "a".repeat(40),
        summary: "ok",
        logSha256: "b".repeat(64),
      }),
    );
    const signoff = decodeRequest({
      _tag: "signoff",
      app: "shop",
      tree: "a".repeat(40),
      commit: "b".repeat(40),
      summary: "ok",
      logSha256: "c".repeat(64),
    });
    assert.equal(signoff._tag, "signoff");
    assert.deepEqual(decodeRequest({ _tag: "signoffs", app: "shop" }), {
      _tag: "signoffs",
      app: "shop",
    });
  });
});

describe("queue signoffs", () => {
  const sample = {
    app: "shop",
    tree: "a".repeat(40),
    commit: "b".repeat(40),
    summary: "line one\nline two",
    logSha256: "c".repeat(64),
  };

  it("migrates signoffs on a new database and on one already at version 4", async () => {
    const { root, paths } = tempRoot();
    try {
      await withStore(
        paths,
        fakeUnits().layer,
        Effect.gen(function* () {
          const store = yield* Store;
          const first = yield* store.recordSignoff(sample);
          assert.equal(first.id, 1);
          assert.equal(first.app, "shop");
          const second = yield* store.recordSignoff({ ...sample, summary: "newer" });
          assert.equal(second.id, 2);
          const listed = yield* store.listSignoffs("shop");
          assert.deepEqual(
            listed.map((row) => row.summary),
            ["newer", "line one\nline two"],
          );
          assert.deepEqual(yield* store.listSignoffs("other"), []);
        }),
      );

      // Drop migration 5 so the next open upgrades a current (v4, images) database.
      const reset = spawnSync(
        process.execPath,
        [
          "-e",
          `
          const { Database } = require("bun:sqlite");
          const db = new Database(${JSON.stringify(paths.database)});
          db.run("DELETE FROM schema_migrations WHERE version = 5");
          db.run("DROP TABLE signoffs");
          db.close();
          `,
        ],
        { encoding: "utf8" },
      );
      assert.equal(reset.status, 0, reset.stderr);

      await withStore(
        paths,
        fakeUnits().layer,
        Effect.gen(function* () {
          const store = yield* Store;
          const again = yield* store.recordSignoff(sample);
          assert.equal(again.id, 1);
          assert.equal((yield* store.listSignoffs("shop")).length, 1);
        }),
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("stores a signoff over the socket and lists newest first; malformed gets error", async () => {
    const { root, paths } = tempRoot();
    const server = await runServe(paths, fakeUnits().layer);
    try {
      const first = await Effect.runPromise(request(paths.socket, { _tag: "signoff", ...sample }));
      assert.deepEqual(first, { _tag: "signedOff", id: 1 });
      await delay(5);
      const second = await Effect.runPromise(
        request(paths.socket, {
          _tag: "signoff",
          ...sample,
          summary: "second",
        }),
      );
      assert.deepEqual(second, { _tag: "signedOff", id: 2 });

      const listed = await Effect.runPromise(
        request(paths.socket, { _tag: "signoffs", app: "shop" }),
      );
      assert.equal(listed._tag, "signoffsListed");
      if (listed._tag === "signoffsListed") {
        assert.deepEqual(
          listed.signoffs.map((row) => row.summary),
          ["second", "line one\nline two"],
        );
      }

      // Bypass the client encoder so the front end sees a malformed line and answers error.
      const raw = await new Promise<string>((resolve, reject) => {
        const sock = createConnection(paths.socket, () => {
          sock.write(
            `${JSON.stringify({
              _tag: "signoff",
              app: "shop",
              tree: "short",
              commit: sample.commit,
              summary: "x",
              logSha256: sample.logSha256,
            })}\n`,
          );
        });
        let buffer = "";
        sock.on("data", (chunk) => {
          buffer += chunk.toString();
          if (buffer.includes("\n")) {
            sock.end();
            resolve(buffer.slice(0, buffer.indexOf("\n")));
          }
        });
        sock.on("error", reject);
      });
      assert.equal(JSON.parse(raw)._tag, "error");
    } finally {
      await server.stop();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("refuses an image lookup whose key is not a hash, and has no request that records an image", () => {
    assert.throws(() => decodeRequest({ _tag: "findImage", repository: "r/app", key: "HEAD" }));
    // Only the runner's build job records an image, after the registry answered for it.
    assert.throws(() =>
      decodeRequest({
        _tag: "recordImage",
        repository: "r/app",
        key: "a".repeat(40),
        digest: `sha256:${"b".repeat(64)}`,
      }),
    );
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
            stagedImage: null,
          });
          yield* store.enqueue({
            command: "plan",
            stage: "b",
            cartridge: null,
            origin: "",
            revision: "",
            stagedImage: null,
          });
          assert.deepEqual(yield* tryStart(), Option.some(1));
          assert.deepEqual(fake.starts, [1]);
          assert.deepEqual(yield* tryStart(), Option.none());
          assert.deepEqual(fake.starts, [1]);
          yield* store.claim(1, null);
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
            stagedImage: null,
          });
          yield* store.enqueue({
            command: "plan",
            stage: "b",
            cartridge: null,
            origin: "",
            revision: "",
            stagedImage: null,
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
            command: "plan",
            stage: "shop",
            cartridge: "{}",
            origin: "o",
            revision: "r",
            stagedImage: null,
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
            command: "plan",
            stage: "shop",
            cartridge: "{}",
            origin: "o",
            revision: "r",
            stagedImage: null,
          });
          yield* store.reserveNext();
          yield* store.claim(job.id, null);
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
            command: "plan",
            stage: "shop",
            cartridge: "{}",
            origin: "o",
            revision: "r",
            stagedImage: null,
          });
          yield* store.reserveNext();
          yield* store.cancel(job.id);
          const error = yield* Effect.flip(store.claim(job.id, null));
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
  it("serves after a killed front end left its socket file behind", async () => {
    const { root, paths } = tempRoot();
    // A process that exits without closing its server leaves the socket file, as a crash does.
    const killed = spawnSync(process.execPath, [
      "-e",
      `require("node:net").createServer().listen(${JSON.stringify(paths.socket)}, () => process.exit(0))`,
    ]);
    assert.equal(killed.status, 0);
    assert.ok(existsSync(paths.socket));
    const server = await runServe(paths, fakeUnits().layer);
    try {
      const listed = await Effect.runPromise(request(paths.socket, { _tag: "list" }));
      assert.equal(listed._tag, "listed");
    } finally {
      await server.stop();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("gives two ids for duplicate submits and cancels only queued jobs", async () => {
    const { root, paths } = tempRoot();
    const fake = fakeUnits();
    const server = await runServe(paths, fake.layer);
    try {
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
          yield* (yield* Store).claim(1, null);
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

  it("finds the digest the store recorded for an image key, and a later record replaces it", async () => {
    const { root, paths } = tempRoot();
    const server = await runServe(paths, fakeUnits().layer);
    const image = { repository: "registry.cluster:5000/shop", key: "c".repeat(40) };
    const find = () => Effect.runPromise(request(paths.socket, { _tag: "findImage", ...image }));
    try {
      assert.deepEqual(await find(), { _tag: "imageFound", digest: null });
      for (const digest of [`sha256:${"1".repeat(64)}`, `sha256:${"2".repeat(64)}`]) {
        await withStore(
          paths,
          fakeUnits().layer,
          Effect.flatMap(Store, (store) => store.recordImage({ ...image, digest })),
        );
        assert.deepEqual(await find(), { _tag: "imageFound", digest });
      }
      const other = await Effect.runPromise(
        request(paths.socket, { _tag: "findImage", ...image, key: "d".repeat(40) }),
      );
      assert.deepEqual(other, { _tag: "imageFound", digest: null });
    } finally {
      await server.stop();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("wait returns when the job ends", async () => {
    const { root, paths } = tempRoot();
    const fake = fakeUnits();
    const server = await runServe(paths, fake.layer);
    try {
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
          yield* store.claim(submitted.id, null);
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
    const server = await runServe(paths, fake.layer);
    try {
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
    const server = await runServe(paths, fake.layer);
    try {
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
    const server = await runServe(paths, fake.layer);
    try {
      await Effect.runPromise(request(paths.socket, stageSubmit));
      await Effect.runPromise(request(paths.socket, { ...stageSubmit, stage: "other" }));
      assert.deepEqual(fake.starts, [1]);

      await withStore(
        paths,
        fake.layer,
        Effect.gen(function* () {
          yield* (yield* Store).claim(1, null);
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
            stagedImage: null,
          });
          yield* store.reserveNext();
          yield* store.claim(job.id, null);
          const error = yield* Effect.flip(finished(job.id, paths));
          assert.ok(error._tag !== undefined);
        }),
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("queue crash recovery of stageless jobs", () => {
  it("plans nothing after an interrupted stageless job", async () => {
    const { root, paths } = tempRoot();
    try {
      await withStore(
        paths,
        fakeUnits().layer,
        Effect.gen(function* () {
          const store = yield* Store;
          const job = yield* store.enqueue({ command: "deployment", name: "shop" });
          yield* store.reserveNext();
          yield* store.claim(job.id, null);
          assert.deepEqual(yield* store.recoverInterrupted(), []);
          assert.equal((yield* store.get(job.id)).state, "interrupted");
        }),
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

/** journalctl as the submit client runs it: a follower prints one entry and stays open. */
const journalSpawner = (log: Array<string>) =>
  Layer.succeed(
    Spawner.ChildProcessSpawner,
    Spawner.make((command) => {
      const args = ChildProcess.isStandardCommand(command) ? command.args : [];
      log.push(["journalctl", ...args].join(" "));
      const entry = new TextEncoder().encode(
        `${JSON.stringify({ __CURSOR: "c1", MESSAGE: "hi" })}\n`,
      );
      const stdout = args.includes("-f")
        ? Stream.concat(Stream.make(entry), Stream.never)
        : Stream.empty;
      return Effect.succeed(
        Spawner.makeHandle({
          pid: Spawner.ProcessId(1),
          exitCode: Effect.succeed(Spawner.ExitCode(0)),
          isRunning: Effect.succeed(true),
          kill: () => Effect.void,
          stdin: Sink.drain,
          stdout,
          stderr: Stream.empty,
          all: Stream.empty,
          getInputFd: () => Sink.drain,
          getOutputFd: () => Stream.empty,
          unref: Effect.succeed(Effect.void),
        }),
      );
    }),
  );

describe("queue migration", () => {
  it("adds runner_revision to an existing v1 database", async () => {
    const { root, paths } = tempRoot();
    try {
      const seeded = spawnSync(
        process.execPath,
        [
          "-e",
          `
          const { Database } = require("bun:sqlite");
          const db = new Database(${JSON.stringify(paths.database)});
          db.run(\`
            CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY NOT NULL);
            INSERT INTO schema_migrations (version) VALUES (1);
            CREATE TABLE jobs (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              command TEXT NOT NULL,
              payload TEXT NOT NULL,
              state TEXT NOT NULL,
              exit_code INTEGER,
              created_at TEXT NOT NULL,
              started_at TEXT,
              finished_at TEXT
            );
          \`);
          db.close();
          `,
        ],
        { encoding: "utf8" },
      );
      assert.equal(seeded.status, 0, seeded.stderr);
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
            stagedImage: null,
          });
          yield* store.reserveNext();
          const claimed = yield* store.claim(job.id, "abc123");
          assert.equal(claimed.runnerRevision, "abc123");
          const listed = yield* store.list();
          assert.equal(listed[0]?.runnerRevision, "abc123");
        }),
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("queue plan gate", () => {
  const deployOf = (planJobId: number, cartridge: string | null = '{"name":"shop"}') => ({
    command: "deploy" as const,
    stage: "shop",
    cartridge,
    origin: "o",
    revision: "r",
    stagedImage: null,
    planJobId,
  });

  const succeedPlan = (revision: string | null, cartridge: string | null) =>
    Effect.gen(function* () {
      const store = yield* Store;
      const plan = yield* store.enqueue({
        command: "plan",
        stage: "shop",
        cartridge,
        origin: "o",
        revision: "r",
        stagedImage: null,
      });
      yield* store.reserveNext();
      yield* store.claim(plan.id, revision);
      yield* store.finish(plan.id, 0);
      return plan.id;
    });

  it("refuses when the plan job is missing", async () => {
    const { root, paths } = tempRoot();
    try {
      await withStore(
        paths,
        fakeUnits().layer,
        Effect.gen(function* () {
          const error = yield* Effect.flip((yield* Store).requireFreshPlan(deployOf(99), "rev"));
          assert.equal(error._tag, "PlanStale");
          assert.match(error.message, /no such job/);
          assert.match(error.message, /plan in job 99 is stale/);
        }),
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("refuses when the plan did not succeed", async () => {
    const { root, paths } = tempRoot();
    try {
      await withStore(
        paths,
        fakeUnits().layer,
        Effect.gen(function* () {
          const store = yield* Store;
          const plan = yield* store.enqueue({
            command: "plan",
            stage: "shop",
            cartridge: "{}",
            origin: "o",
            revision: "r",
            stagedImage: null,
          });
          yield* store.reserveNext();
          yield* store.claim(plan.id, "rev");
          yield* store.finish(plan.id, 1);
          const error = yield* Effect.flip(store.requireFreshPlan(deployOf(plan.id), "rev"));
          assert.equal(error._tag, "PlanStale");
          assert.match(error.message, /the plan failed/);
        }),
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("refuses when the named job is not a plan", async () => {
    const { root, paths } = tempRoot();
    try {
      await withStore(
        paths,
        fakeUnits().layer,
        Effect.gen(function* () {
          const store = yield* Store;
          const drift = yield* store.enqueue({
            command: "drift",
            stage: "shop",
            cartridge: "{}",
            origin: "o",
            revision: "r",
            stagedImage: null,
          });
          yield* store.reserveNext();
          yield* store.claim(drift.id, "rev");
          yield* store.finish(drift.id, 0);
          const error = yield* Effect.flip(store.requireFreshPlan(deployOf(drift.id), "rev"));
          assert.equal(error._tag, "PlanStale");
          assert.match(error.message, /not a plan/);
        }),
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("refuses when the stage differs", async () => {
    const { root, paths } = tempRoot();
    try {
      await withStore(
        paths,
        fakeUnits().layer,
        Effect.gen(function* () {
          const store = yield* Store;
          const id = yield* succeedPlan("rev", "{}");
          const error = yield* Effect.flip(
            store.requireFreshPlan({ ...deployOf(id, "{}"), stage: "other" }, "rev"),
          );
          assert.equal(error._tag, "PlanStale");
          assert.match(error.message, /another stage/);
        }),
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("refuses when the cartridge differs", async () => {
    const { root, paths } = tempRoot();
    try {
      await withStore(
        paths,
        fakeUnits().layer,
        Effect.gen(function* () {
          const store = yield* Store;
          const id = yield* succeedPlan("rev", '{"name":"shop"}');
          const error = yield* Effect.flip(
            store.requireFreshPlan(deployOf(id, '{"name":"other"}'), "rev"),
          );
          assert.equal(error._tag, "PlanStale");
          assert.match(error.message, /another cartridge/);
        }),
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("refuses when the released commit differs", async () => {
    const { root, paths } = tempRoot();
    try {
      await withStore(
        paths,
        fakeUnits().layer,
        Effect.gen(function* () {
          const store = yield* Store;
          const id = yield* succeedPlan("rev", "{}");
          const error = yield* Effect.flip(
            store.requireFreshPlan({ ...deployOf(id, "{}"), revision: "other" }, "rev"),
          );
          assert.equal(error._tag, "PlanStale");
          assert.match(error.message, /another release commit/);
        }),
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("refuses when the runner revision differs", async () => {
    const { root, paths } = tempRoot();
    try {
      await withStore(
        paths,
        fakeUnits().layer,
        Effect.gen(function* () {
          const store = yield* Store;
          const id = yield* succeedPlan("old-rev", "{}");
          const error = yield* Effect.flip(store.requireFreshPlan(deployOf(id, "{}"), "new-rev"));
          assert.equal(error._tag, "PlanStale");
          assert.match(error.message, /another runner revision/);
        }),
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("refuses when a deploy finished after the plan", async () => {
    const { root, paths } = tempRoot();
    try {
      await withStore(
        paths,
        fakeUnits().layer,
        Effect.gen(function* () {
          const store = yield* Store;
          const id = yield* succeedPlan("rev", "{}");
          const later = yield* store.enqueue({ ...deployOf(id, "{}"), stage: "other" });
          yield* store.reserveNext();
          yield* store.claim(later.id, "rev");
          yield* store.finish(later.id, 0);
          const error = yield* Effect.flip(store.requireFreshPlan(deployOf(id, "{}"), "rev"));
          assert.equal(error._tag, "PlanStale");
          assert.match(error.message, /changed resources since/);
        }),
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("stays fresh across stageless jobs and a drift check", async () => {
    const { root, paths } = tempRoot();
    try {
      await withStore(
        paths,
        fakeUnits().layer,
        Effect.gen(function* () {
          const store = yield* Store;
          const id = yield* succeedPlan("rev", "{}");
          for (const submit of [
            { command: "status" as const, name: "shop" },
            { command: "stage-image" as const, name: "shop", stable: true, expect: null },
            {
              command: "drift" as const,
              stage: "shop",
              cartridge: null,
              origin: "",
              revision: "",
              stagedImage: null,
            },
          ]) {
            const later = yield* store.enqueue(submit);
            yield* store.reserveNext();
            yield* store.claim(later.id, "rev");
            yield* store.finish(later.id, 0);
          }
          yield* store.requireFreshPlan(deployOf(id, "{}"), "rev");
        }),
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("accepts a fresh plan of the same stage, cartridge, and revision", async () => {
    const { root, paths } = tempRoot();
    try {
      await withStore(
        paths,
        fakeUnits().layer,
        Effect.gen(function* () {
          const store = yield* Store;
          const id = yield* succeedPlan("rev", '{"name":"shop"}');
          yield* store.requireFreshPlan(deployOf(id), "rev");
        }),
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

/** What `alchemy-runner submit` then `wait` do, in one effect. */
const submitThenWait = (body: object, socket: string) =>
  submitJob(JSON.stringify(body), socket).pipe(Effect.flatMap((id) => waitJob(id, socket)));

describe("queue submit client", () => {
  it("submits from a request, waits, and exits with the job code", async () => {
    const { root, paths } = tempRoot();
    const fake = fakeUnits();
    const journalLog: Array<string> = [];
    const server = await runServe(paths, fake.layer);
    try {
      const body = {
        _tag: "submit" as const,
        command: "plan" as const,
        stage: "shop",
        cartridge: null,
        origin: "",
        revision: "",
        stagedImage: null,
      };
      const running = Effect.runPromise(
        submitThenWait(body, paths.socket).pipe(
          Effect.provide(journalSpawner(journalLog)),
          Effect.provide(BunServices.layer),
          Effect.flip,
        ) as Effect.Effect<{ readonly _tag: string; readonly code?: number }, never>,
      );
      await Effect.runPromise(
        request(paths.socket, { _tag: "show", id: 1 }).pipe(
          Effect.retry({ schedule: Schedule.spaced("10 millis"), times: 200 }),
        ),
      );
      await withStore(
        paths,
        fake.layer,
        Effect.gen(function* () {
          const store = yield* Store;
          yield* store.claim(1, null);
          yield* store.finish(1, 0);
        }),
      );
      const exit = await running;
      assert.equal(exit._tag, "SubmitExit");
      if (exit._tag === "SubmitExit") assert.equal(exit.code, 0);
      assert.deepEqual(journalLog, [
        "journalctl _SYSTEMD_UNIT=alchemy-job@1.service -o json -f -n all",
        "journalctl _SYSTEMD_UNIT=alchemy-job@1.service -o json --after-cursor=c1",
      ]);
    } finally {
      await server.stop();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("cancels a queued job on interrupt and exits 130", async () => {
    const { root, paths } = tempRoot();
    const fake = fakeUnits();
    const journalLog: Array<string> = [];
    const server = await runServe(paths, fake.layer);
    try {
      // Hold the queue with a running job so the second submit stays queued.
      await Effect.runPromise(request(paths.socket, stageSubmit));
      await withStore(
        paths,
        fake.layer,
        Effect.gen(function* () {
          yield* (yield* Store).claim(1, null);
        }),
      );
      const body = { ...stageSubmit, stage: "other" };
      const fiber = Effect.runFork(
        submitThenWait(body, paths.socket).pipe(
          Effect.provide(journalSpawner(journalLog)),
          Effect.provide(BunServices.layer),
        ) as Effect.Effect<never, unknown>,
      );
      await Effect.runPromise(
        request(paths.socket, { _tag: "show", id: 2 }).pipe(
          Effect.retry({ schedule: Schedule.spaced("10 millis"), times: 200 }),
        ),
      );
      await Effect.runPromise(Fiber.interrupt(fiber));
      const shown = await Effect.runPromise(request(paths.socket, { _tag: "show", id: 2 }));
      assert.equal(shown._tag, "shown");
      if (shown._tag === "shown") assert.equal(shown.job.state, "canceled");
    } finally {
      await server.stop();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("login token request writes only the runner token file", async () => {
    const { root, paths } = tempRoot();
    const fake = fakeUnits();
    const server = await runServe(paths, fake.layer);
    try {
      const operatorFile = join(root, "operator.openbao.token");
      writeFileSync(operatorFile, "should-stay", { mode: 0o600 });
      await Effect.runPromise(request(paths.socket, { _tag: "token", value: "minted-2h-token" }));
      assert.equal(readFileSync(paths.tokenFile, "utf8"), "minted-2h-token");
      assert.equal(readFileSync(operatorFile, "utf8"), "should-stay");
    } finally {
      await server.stop();
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("queue protocol deploy", () => {
  it("requires planJobId on deploy submits", () => {
    assert.throws(() =>
      decodeRequest({
        _tag: "submit",
        command: "deploy",
        stage: "shop",
        cartridge: null,
        origin: "",
        revision: "",
        stagedImage: null,
      }),
    );
    const ok = decodeRequest({
      _tag: "submit",
      command: "deploy",
      stage: "shop",
      cartridge: null,
      origin: "",
      revision: "",
      stagedImage: null,
      planJobId: 3,
    });
    assert.equal(ok._tag, "submit");
    if (ok._tag === "submit" && ok.command === "deploy") assert.equal(ok.planJobId, 3);
  });
});

describe("build upload", () => {
  const upload = {
    _tag: "build",
    repository: "registry.cluster:5000/shop",
    key: "e".repeat(40),
    memoryMaxMB: 2048,
  };

  /** Send the request line and `bytes` raw bytes, then read the one response line. */
  const send = (paths: Paths, header: object, bytes: Buffer) =>
    new Promise<{ _tag: string; id?: number; message?: string }>((resolve, reject) => {
      const sock = createConnection(paths.socket);
      let raw = "";
      sock.on("data", (chunk) => {
        raw += chunk.toString("utf8");
        if (raw.includes("\n")) {
          sock.end();
          resolve(JSON.parse(raw));
        }
      });
      sock.on("error", reject);
      sock.write(`${JSON.stringify(header)}\n`);
      sock.write(bytes);
    });

  it("stores the tar byte for byte under the spool id and queues a build job that names it", async () => {
    const { root, paths } = tempRoot();
    const server = await runServe(paths, fakeUnits().layer);
    // Every byte value, so a text decoder anywhere on the path would change the file.
    const tar = Buffer.from(Array.from({ length: 70_000 }, (_, index) => index % 256));
    try {
      const answer = await send(paths, { ...upload, size: tar.length }, tar);
      assert.equal(answer._tag, "submitted");
      const job = await withStore(
        paths,
        fakeUnits().layer,
        Effect.flatMap(Store, (store) => store.get(answer.id!)),
      );
      assert.ok(job.submit.command === "build");
      assert.equal(job.submit.repository, upload.repository);
      assert.deepEqual(readFileSync(spoolFile(paths, job.submit.spool)), tar);
    } finally {
      await server.stop();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("refuses an upload longer than its size, and leaves no file in the spool", async () => {
    const { root, paths } = tempRoot();
    const server = await runServe(paths, fakeUnits().layer);
    try {
      const answer = await send(paths, { ...upload, size: 10 }, Buffer.alloc(50, 1));
      assert.equal(answer._tag, "error");
      assert.deepEqual(readdirSync(paths.spool), []);
    } finally {
      await server.stop();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("sweeps spool files that no live build job names", async () => {
    const { root, paths } = tempRoot();
    mkdirSync(paths.spool, { recursive: true });
    const live = "11111111-1111-1111-1111-111111111111";
    const orphan = "22222222-2222-2222-2222-222222222222";
    writeFileSync(spoolFile(paths, live), "x");
    writeFileSync(spoolFile(paths, orphan), "x");
    try {
      await withStore(
        paths,
        fakeUnits().layer,
        Effect.gen(function* () {
          const store = yield* Store;
          yield* store.enqueue({
            command: "build",
            repository: upload.repository,
            key: upload.key,
            spool: live,
            memoryMaxMB: 2048,
          });
          yield* sweepSpool(paths);
        }),
      );
      assert.deepEqual(readdirSync(paths.spool), [`${live}.tar`]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
