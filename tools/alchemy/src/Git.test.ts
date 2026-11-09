import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import * as BunServices from "@effect/platform-bun/BunServices";
import { Effect, FileSystem } from "effect";
import * as Exec from "./Exec.ts";
import { exportArchive, exportTree, push } from "./Git.ts";

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

describe("exportArchive", () => {
  it("lets every user read every entry, whatever the git config, and has no root folder entry", async () => {
    // The Nomad client unpacks the archive as root, and the builder user must read it.
    const listing = await Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const repository = yield* fs.makeTempDirectoryScoped();
      const archive = `${yield* fs.makeTempDirectoryScoped()}/tree.tar`;
      const git = (...args: ReadonlyArray<string>) =>
        Exec.run("git", [
          ...["-c", "user.name=t", "-c", "user.email=t@t", "-C", repository, ...args],
        ]);
      yield* git("init", "--quiet");
      yield* git("config", "tar.umask", "0077");
      yield* fs.makeDirectory(`${repository}/app`);
      yield* fs.writeFileString(`${repository}/app/main.ts`, "x\n");
      yield* fs.writeFileString(`${repository}/run.sh`, "x\n");
      yield* fs.chmod(`${repository}/run.sh`, 0o755);
      yield* git("add", "-A");
      yield* git("commit", "--quiet", "-m", "one");

      yield* exportArchive(repository, "HEAD", archive);
      return yield* Exec.output("tar", ["-tvf", archive]);
    }).pipe(Effect.scoped, Effect.provide(BunServices.layer), Effect.runPromise);

    const modes = Object.fromEntries(
      listing
        .trim()
        .split("\n")
        .map((line) => line.split(/\s+/))
        .map((fields) => [fields.at(-1), fields[0]]),
    );
    assert.deepEqual(modes, {
      "app/": "drwxr-xr-x",
      "app/main.ts": "-rw-r--r--",
      "run.sh": "-rwxr-xr-x",
    });
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
