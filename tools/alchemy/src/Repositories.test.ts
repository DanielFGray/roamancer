import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as BunServices from "@effect/platform-bun/BunServices";
import { Effect, type FileSystem } from "effect";
import type { ChildProcessSpawner } from "effect/process/ChildProcessSpawner";
import * as Repositories from "./Repositories.ts";

describe("Repositories", () => {
  const run = <A, E>(effect: Effect.Effect<A, E, FileSystem.FileSystem | ChildProcessSpawner>) =>
    Effect.runPromise(effect.pipe(Effect.provide(BunServices.layer)));

  it("makes a repository once, lists only app repositories by name, and refuses a path", async () => {
    const root = mkdtempSync(join(tmpdir(), "repositories-"));
    try {
      mkdirSync(join(root, "Not-An-App.git"));
      mkdirSync(join(root, "notes"));
      for (const app of ["shop", "blog"]) {
        assert.equal(await run(Repositories.create(root, app)), true);
      }
      assert.equal(await run(Repositories.create(root, "shop")), false);
      await assert.rejects(run(Repositories.create(root, "../shop")));
      assert.deepEqual(await run(Repositories.listApps(root)), ["blog", "shop"]);
      const head = spawnSync("git", ["-C", join(root, "shop.git"), "symbolic-ref", "HEAD"], {
        encoding: "utf8",
      });
      assert.equal(head.stdout.trim(), "refs/heads/main");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
