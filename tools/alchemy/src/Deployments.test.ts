import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { Deployments, layer } from "./Deployments.ts";

const run = <A, E>(effect: Effect.Effect<A, E, Deployments>) =>
  Effect.runPromise(
    effect.pipe(
      Effect.provide(layer(join(mkdtempSync(join(tmpdir(), "deployments-")), "d.sqlite"))),
    ),
  );

const shop = { name: "shop", origin: "root-a", revision: "c1", cartridge: "{}" };

describe("Deployments", () => {
  it("returns the newest record first and finds one by id", async () => {
    const { latest, older } = await run(
      Effect.gen(function* () {
        const deployments = yield* Deployments;
        const first = yield* deployments.record(shop);
        yield* deployments.record({ ...shop, revision: "c2" });
        return {
          latest: yield* deployments.latest("shop"),
          older: yield* deployments.get("shop", first.id),
        };
      }),
    );
    assert.equal(Option.getOrThrow(latest).revision, "c2");
    assert.equal(Option.getOrThrow(older).revision, "c1");
  });

  it("refuses a name from a second repository", async () => {
    const error = await run(
      Effect.gen(function* () {
        const deployments = yield* Deployments;
        yield* deployments.record(shop);
        return yield* Effect.flip(deployments.record({ ...shop, origin: "root-b" }));
      }),
    );
    assert.equal(error._tag, "OriginMismatch");
  });

  it("lists the newest record of each name", async () => {
    const newest = await run(
      Effect.gen(function* () {
        const deployments = yield* Deployments;
        yield* deployments.record(shop);
        yield* deployments.record({ ...shop, revision: "c2" });
        yield* deployments.record({ ...shop, name: "blog", origin: "root-b" });
        return yield* deployments.newest();
      }),
    );
    assert.deepEqual(
      newest.map((d) => `${d.name} ${d.revision}`),
      ["blog c1", "shop c2"],
    );
  });

  it("keeps each name's records apart", async () => {
    const other = await run(
      Effect.gen(function* () {
        const deployments = yield* Deployments;
        yield* deployments.record(shop);
        yield* deployments.record({ ...shop, name: "blog", origin: "root-b" });
        return yield* deployments.list("blog");
      }),
    );
    assert.deepEqual(
      other.map((d) => d.origin),
      ["root-b"],
    );
  });
});
