import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as BunServices from "@effect/platform-bun/BunServices";
import { Context, Effect, Layer, Option, Stream } from "effect";
import { Builder } from "./Builder.ts";
import { OpsError } from "./Exec.ts";
import { Remote } from "./Remote.ts";

const digest = `sha256:${"a".repeat(64)}`;
const image = { repository: "registry.cluster:5000/probe", key: "c".repeat(40) };

describe("Builder.build", () => {
  it("sends one request line and a tar of exactly `size` bytes, waits for the job, and pins the recorded digest", async () => {
    const run = await build(Option.some(digest));
    const newline = run.sent.indexOf(10);
    const request = JSON.parse(new TextDecoder().decode(run.sent.subarray(0, newline)));
    assert.deepEqual(
      { ...request, size: undefined },
      { _tag: "build", ...image, memoryMaxMB: 1024, size: undefined },
    );
    assert.equal(run.sent.length - newline - 1, request.size);
    assert.deepEqual(run.waited, [["wait", "7"]]);
    assert.equal(run.result, `${image.repository}:${image.key}@${digest}`);
  });

  it("fails when the job ended without recording an image", async () => {
    const run = await build(Option.none());
    assert.ok(run.error instanceof OpsError);
    assert.match(run.error.message, /ended without recording an image/);
  });
});

/** Build a one-file tree through a fake runner connection that records what it is sent. */
const build = async (recorded: Option.Option<string>) => {
  const tree = mkdtempSync(join(tmpdir(), "builder-tree-"));
  writeFileSync(join(tree, "Dockerfile"), "FROM scratch\n");
  let sent = new Uint8Array(0);
  const waited: Array<ReadonlyArray<string>> = [];
  const remote = {
    build: (request: Stream.Stream<Uint8Array, unknown>) =>
      Stream.runCollect(request).pipe(
        Effect.map((chunks) => {
          sent = Uint8Array.from(chunks.flatMap((chunk) => [...chunk]));
          return 7;
        }),
      ),
    direct: (args: ReadonlyArray<string>) => Effect.sync(() => void waited.push(args)),
    findImage: () => Effect.succeed(recorded),
  } as unknown as Context.Service.Shape<typeof Remote>;
  try {
    const outcome = await Effect.gen(function* () {
      return yield* (yield* Builder).build(tree, image, 1024);
    }).pipe(
      Effect.map((value) => ({ result: value, error: undefined })),
      Effect.catch((failure) => Effect.succeed({ result: undefined, error: failure })),
      Effect.provide(Builder.layer.pipe(Layer.provide(Layer.succeed(Remote, remote)))),
      Effect.provide(BunServices.layer),
      Effect.runPromise,
    );
    return { ...outcome, sent, waited };
  } finally {
    rmSync(tree, { recursive: true, force: true });
  }
};
