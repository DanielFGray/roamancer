/**
 * Sending a repository's committed state to a host, and exporting it for a local build. Only
 * the commit at HEAD travels, so the working tree here may stay dirty while a deploy runs
 * exactly what was committed.
 *
 * On a host, each repository is a checkout in the operator's home folder on a `deploy`
 * branch that accepts pushes (`receive.denyCurrentBranch=updateInstead`): git updates the
 * checkout's files and leaves ignored ones, such as Alchemy's state, in place. It refuses the
 * push when someone has edited a tracked file on the host by hand.
 */
import { Console, Effect, FileSystem } from "effect";
import * as Exec from "./Exec.ts";

/** Where each host keeps its checkout of the repository, relative to the operator's home. */
export const checkout = "server-ansible";

/** The repository this program runs from: the code a deploy sends. */
export const repository = new URL("../../..", import.meta.url).pathname.replace(/\/$/, "");

/**
 * Make `remote` (a folder in the home of `target`'s account) a checkout of `dir`'s HEAD.
 * Pushes with --force, because a rewritten history must still deploy. The host declares the
 * checkout in nixos/modules/deploy-repos.nix.
 */
export const push = Effect.fn("Git.push")(function* (target: string, dir: string, remote: string) {
  // A subfolder of a repository would push the repository's root while a local export
  // writes only the subfolder.
  const prefix = yield* Exec.output("git", ["-C", dir, "rev-parse", "--show-prefix"]).pipe(
    Effect.orElseSucceed(() => ""),
  );
  if (prefix.trim() !== "") {
    return yield* new Exec.OpsError({
      message: `${dir} is a folder inside a git repository; name the repository's top folder`,
    });
  }
  yield* announce(dir, `to ${target}:${remote}`);
  yield* Exec.run("git", [
    ...["-C", dir, "push", "--quiet", "--force"],
    `${target}:${remote}`,
    "HEAD:refs/heads/deploy",
  ]);
});

/** Write `treeish` of `dir` (for example `HEAD` or `HEAD:nixos`) into the folder `destination`. */
export const exportTree = Effect.fn("Git.exportTree")(function* (
  dir: string,
  treeish: string,
  destination: string,
  purpose = "for a local build",
) {
  const fs = yield* FileSystem.FileSystem;
  const archive = `${yield* fs.makeTempDirectoryScoped()}/tree.tar`;
  yield* exportArchive(dir, treeish, archive, purpose);
  yield* unpack(archive, destination);
}, Effect.scoped);

/**
 * Write `treeish` of `dir` as git's tar to the file `archive`. Each entry's mode comes from the
 * commit and a fixed `tar.umask`, so every file is 0644 or 0755 and every folder 0755 whatever
 * the operator's git config or umask, and the tar has no entry for its root folder.
 */
export const exportArchive = Effect.fn("Git.exportArchive")(function* (
  dir: string,
  treeish: string,
  archive: string,
  purpose = "for a local build",
) {
  yield* announce(dir, `${purpose} (${treeish})`, treeish.split(":")[0]);
  yield* Exec.run("git", [
    ...["-c", "tar.umask=0022", "-C", dir, "archive", "--format=tar", "-o", archive, treeish],
  ]);
});

/** Unpack the tar `archive` into the folder `destination`. */
export const unpack = Effect.fn("Git.unpack")(function* (archive: string, destination: string) {
  yield* (yield* FileSystem.FileSystem).makeDirectory(destination, { recursive: true });
  yield* Exec.run("tar", ["-xf", archive, "-C", destination]);
});

/** Name the commit about to be used, and how many changes it leaves out. */
const announce = Effect.fn("Git.announce")(function* (
  dir: string,
  purpose: string,
  revision = "HEAD",
) {
  const commit = yield* Exec.output("git", ["-C", dir, "rev-parse", "--short", revision]).pipe(
    Effect.mapError(
      () => new Exec.OpsError({ message: `${dir} is not a git repository with a commit` }),
    ),
  );
  const changes = (yield* Exec.output("git", ["-C", dir, "status", "--porcelain"]))
    .split("\n")
    .filter((line) => line !== "");
  yield* Console.error(
    `${dir} ${commit.trim()} ${purpose}` +
      (changes.length === 0 ? "" : ` (${changes.length} uncommitted changes stay here)`),
  );
});
