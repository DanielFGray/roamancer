/**
 * The apps' bare repositories on the control host: `<app>.git` in the repositories folder
 * (queue/Paths.ts). The folder is the list of apps that reconcile releases on a push, so
 * adding an app needs no host rebuild. An app with no repository there is released only with
 * `ops release`. The operator owns the folder and makes each repository (`ops repo create`);
 * the runner only reads them, so a job cannot add an app or change what was pushed.
 */
import { Effect, FileSystem, Schema as S } from "effect";
import * as Exec from "./Exec.ts";
import { repositoryOf } from "./queue/Paths.ts";

/** An app name, which is its cartridge's name. It becomes a folder name, so it holds no path. */
const appName = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export class InvalidAppName extends S.TaggedError<InvalidAppName>()("InvalidAppName", {
  message: S.String,
}) {}

/** The apps that have a repository in `repositories`, by name. */
export const listApps = Effect.fn("Repositories.listApps")(function* (repositories: string) {
  const entries = yield* (yield* FileSystem.FileSystem).readDirectory(repositories);
  return entries
    .filter((entry) => entry.endsWith(".git"))
    .map((entry) => entry.slice(0, -".git".length))
    .filter((app) => appName.test(app))
    .sort();
});

/** Whether `app` has a repository in `repositories`. */
export const has = Effect.fn("Repositories.has")(function* (repositories: string, app: string) {
  return yield* (yield* FileSystem.FileSystem).exists(repositoryOf(repositories, app));
});

/**
 * Make `app`'s bare repository unless it has one, and return whether it made one. It runs as
 * the operator. --shared=0640 keeps every file the operator's and readable by the folder's
 * group, whatever umask a later push runs with.
 */
export const create = Effect.fn("Repositories.create")(function* (
  repositories: string,
  app: string,
) {
  if (!appName.test(app)) {
    return yield* new InvalidAppName({
      message: `'${app}' is not an app name: lowercase letters, digits and single hyphens`,
    });
  }
  if (yield* has(repositories, app)) return false;
  yield* Exec.run("git", [
    "init",
    "--bare",
    "--quiet",
    "--shared=0640",
    "-b",
    "main",
    repositoryOf(repositories, app),
  ]);
  return true;
});
