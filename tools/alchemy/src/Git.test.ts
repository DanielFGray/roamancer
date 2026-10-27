import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import * as BunServices from "@effect/platform-bun/BunServices";
import { Effect, FileSystem } from "effect";
import * as Exec from "./Exec.ts";
import { exportTree, push } from "./Git.ts";

describe("exportTree", () => {
  it("writes the committed tree, not the working tree", async () => {
    const exported = await Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const repository = yield* fs.makeTempDirectoryScoped();
      const destination = `${yield* fs.makeTempDirectoryScoped()}/out`;
      const git = (...args: ReadonlyArray<string>) =>
        Exec.run("git", [
          ...["-c", "user.name=t", "-c", "user.email=t@t", "-C", repository, ...args],
        ]);
      yield* git("init", "--quiet");
      yield* fs.makeDirectory(`${repository}/nixos`);
      yield* fs.writeFileString(`${repository}/nixos/flake.nix`, "committed\n");
      yield* fs.writeFileString(`${repository}/outside.txt`, "committed\n");
      yield* git("add", "-A");
      yield* git("commit", "--quiet", "-m", "one");
      // Edits and new files that were not committed.
      yield* fs.writeFileString(`${repository}/nixos/flake.nix`, "edited\n");
      yield* fs.writeFileString(`${repository}/nixos/untracked.nix`, "new\n");

      yield* exportTree(repository, "HEAD:nixos", destination);
      return {
        flake: yield* fs.readFileString(`${destination}/flake.nix`),
        files: (yield* fs.readDirectory(destination)).sort(),
      };
    }).pipe(Effect.scoped, Effect.provide(BunServices.layer), Effect.runPromise);

    assert.equal(exported.flake, "committed\n");
    assert.deepEqual(exported.files, ["flake.nix"]);
  });
});

describe("push", () => {
  it("refuses a folder inside a repository, which would deploy the repository's root", async () => {
    const error = await Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const repository = yield* fs.makeTempDirectoryScoped();
      yield* Exec.run("git", ["-C", repository, "init", "--quiet"]);
      yield* fs.makeDirectory(`${repository}/site`);
      return yield* push("nowhere", `${repository}/site`, "site").pipe(Effect.flip);
    }).pipe(Effect.scoped, Effect.provide(BunServices.layer), Effect.runPromise);

    assert.match(error.message, /folder inside a git repository/);
  });
});
