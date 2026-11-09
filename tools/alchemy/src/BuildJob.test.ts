import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import { Context, Effect, Fiber, Layer } from "effect";
import { TestClock, TestConsole } from "effect/testing";
import { BuildFailed, buildJobSpec, buildahImage, runBuild } from "./BuildJob.ts";
import { BuildStore } from "./BuildStore.ts";
import { Nomad, NomadError, type AllocationSummary, type Evaluation } from "./Nomad.ts";
import { Store } from "./queue/Store.ts";
import { Registry } from "./Registry.ts";

const site = { registry: "registry.cluster:5000", registryCaDir: "/var/lib/registry-ca" };
const request = {
  repository: "registry.cluster:5000/shop",
  key: "e".repeat(40),
  jobId: 7,
  tarFile: "/spool/x.tar",
  memoryMaxMB: 1536,
};
const digest = `sha256:${"d".repeat(64)}`;

describe("buildJobSpec", () => {
  const spec = buildJobSpec({
    nomadJob: "build-7",
    repository: request.repository,
    key: request.key,
    artifactUrl: "http://garage/builds/7.tar?sig",
    memoryMaxMB: 1536,
    registryCaDir: site.registryCaDir,
  });
  const task = spec.TaskGroups[0].Tasks[0];

  it("runs on builder workers in the builder's Podman, from the Buildah image", () => {
    assert.deepEqual(spec.Constraints, [
      { LTarget: "${meta.builder}", Operand: "=", RTarget: "true" },
    ]);
    assert.equal(spec.Type, "batch");
    assert.equal(task.Driver, "podman");
    assert.equal(task.Config.socket, "builder");
    assert.equal(task.Config.image, buildahImage);
  });

  it("reserves 256 MB, caps memory at the given maximum, and fetches the tree by URL", () => {
    assert.equal(task.Resources.MemoryMB, 256);
    assert.equal(task.Resources.MemoryMaxMB, 1536);
    assert.deepEqual(task.Artifacts, [
      { GetterSource: "http://garage/builds/7.tar?sig", RelativeDest: "local/tree" },
    ]);
  });

  it("gives the task no workload identity, environment or retry", () => {
    assert.ok(!("Identity" in task));
    assert.ok(!("Env" in task));
    assert.deepEqual(spec.TaskGroups[0].RestartPolicy.Attempts, 0);
  });

  it("builds with chroot isolation and vfs storage, pushes the tag, and prints the digest", () => {
    const script = task.Config.args[1];
    assert.match(
      script,
      /buildah bud --isolation chroot --storage-driver vfs --cert-dir \/run\/registry-ca/,
    );
    assert.match(
      script,
      new RegExp(`buildah push .*--digestfile /tmp/digest ${request.repository}:${request.key}`),
    );
    assert.match(script, /&& cat \/tmp\/digest$/);
    assert.deepEqual(task.Config.volumes, ["/var/lib/registry-ca:/run/registry-ca:ro"]);
  });
});

describe("runBuild", () => {
  it("records the digest under the repository and key it chose, then removes the tree and the job", async () => {
    const run = await build({ printed: `${digest}\n`, registryHas: true });
    assert.equal(run.error, undefined);
    assert.deepEqual(run.recorded, [{ repository: request.repository, key: request.key, digest }]);
    assert.deepEqual(run.uploaded, ["7-" + request.key + ".tar"]);
    assert.deepEqual(run.removed, ["7-" + request.key + ".tar"]);
    assert.deepEqual(run.stopped, ["build-7"]);
  });

  it("refuses a digest the registry does not have, records nothing, and still removes the tree", async () => {
    const run = await build({ printed: `${digest}\n`, registryHas: false });
    assert.ok(run.error instanceof BuildFailed);
    assert.match(run.error.message, /registry has no/);
    assert.deepEqual(run.recorded, []);
    assert.deepEqual(run.removed, ["7-" + request.key + ".tar"]);
  });

  it("reads only the last stdout line, and refuses output that is no digest", async () => {
    const bad = await build({ printed: "sha256:short\n", registryHas: true });
    assert.ok(bad.error instanceof BuildFailed);
    assert.match(bad.error.message, /printed no image digest/);
    assert.deepEqual(bad.recorded, []);
  });

  it("fails a build whose allocation failed", async () => {
    const run = await build({ printed: "", registryHas: true, status: "failed" });
    assert.ok(run.error instanceof BuildFailed);
    assert.match(run.error.message, /ended failed/);
    assert.deepEqual(run.recorded, []);
  });

  it("refuses a repository outside the cluster registry before it uploads anything", async () => {
    const run = await build({
      printed: `${digest}\n`,
      registryHas: true,
      repository: "evil.example/shop",
    });
    assert.ok(run.error instanceof BuildFailed);
    assert.deepEqual(run.uploaded, []);
  });

  it("deletes the tree even when stopping the Nomad job fails", async () => {
    const run = await build({ printed: `${digest}\n`, registryHas: true, stopFails: true });
    assert.equal(run.error, undefined);
    assert.deepEqual(run.removed, ["7-" + request.key + ".tar"]);
  });

  it("fails a job that nothing places, naming the scheduler's reason", async () => {
    const run = await build({ printed: "", registryHas: true, unplaced: true });
    assert.ok(run.error instanceof BuildFailed);
    assert.match(
      run.error.message,
      /not placed within 5 minutes: build: memory exhausted \(1 nodes\)/,
    );
    assert.deepEqual(run.removed, ["7-" + request.key + ".tar"]);
  });
});

/** Run a build against fake Garage, Nomad, registry and store; report what each was asked. */
const build = async (options: {
  readonly printed: string;
  readonly registryHas: boolean;
  readonly status?: string;
  readonly repository?: string;
  readonly unplaced?: boolean;
  readonly stopFails?: boolean;
}) => {
  const uploaded: Array<string> = [];
  const removed: Array<string> = [];
  const stopped: Array<string> = [];
  const recorded: Array<{ repository: string; key: string; digest: string }> = [];
  const allocation = {
    ID: "alloc-1",
    ClientStatus: options.status ?? "complete",
  } as AllocationSummary;
  const evaluation = {
    Status: "blocked",
    FailedTGAllocs: { build: { ConstraintFiltered: null, DimensionExhausted: { memory: 1 } } },
  } as Evaluation;
  const nomad = {
    registerBatch: () => Effect.succeed({ EvalID: "e", JobModifyIndex: 1 }),
    allocations: () => Effect.succeed(options.unplaced ? [] : [allocation]),
    evaluations: () => Effect.succeed([evaluation]),
    logs: (_id: string, _task: string, stream: string) =>
      Effect.succeed(stream === "stdout" ? options.printed : "step 3 failed"),
    stop: (name: string) =>
      options.stopFails
        ? Effect.fail(new NomadError({ op: "stop", cause: "no such job" }))
        : Effect.sync(() => void stopped.push(name)),
  } as unknown as Context.Service.Shape<typeof Nomad>;
  const store = {
    put: (object: string) => Effect.sync(() => void uploaded.push(object)),
    getUrl: (object: string) => Effect.succeed(`http://garage/builds/${object}?sig`),
    remove: (object: string) => Effect.sync(() => void removed.push(object)),
  } as Context.Service.Shape<typeof BuildStore>;
  const registry = { has: () => Effect.succeed(options.registryHas) } as Context.Service.Shape<
    typeof Registry
  >;
  const queue = {
    recordImage: (image: { repository: string; key: string; digest: string }) =>
      Effect.sync(() => void recorded.push(image)),
  } as unknown as Context.Service.Shape<typeof Store>;

  const program = Effect.gen(function* () {
    const fiber = yield* Effect.forkChild(
      runBuild({ ...request, repository: options.repository ?? request.repository }, site).pipe(
        Effect.map(() => undefined),
        Effect.catch((failure) => Effect.succeed(failure)),
      ),
    );
    // Polling sleeps on the clock; move it past the placement limit and the poll spacing.
    yield* TestClock.adjust("6 minutes");
    return yield* Fiber.join(fiber);
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        Layer.succeed(Nomad, nomad),
        Layer.succeed(BuildStore, store),
        Layer.succeed(Registry, registry),
        Layer.succeed(Store, queue),
        TestConsole.layer,
        TestClock.layer(),
      ),
    ),
  );
  const error = await Effect.runPromise(Effect.scoped(program));
  return { error, uploaded, removed, stopped, recorded };
};
