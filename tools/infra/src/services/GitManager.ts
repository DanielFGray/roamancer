import { Effect, Schema as S, Stream } from "effect";
import * as Command from "@effect/platform/Command";
import { BunContext } from "@effect/platform-bun";
import { PROJECTS_DIR, GIT_HOST } from "../lib/config.ts";
import { deploymentPaths, worktreeParent } from "../lib/deployment.ts";
import { DEPLOYMENT_ROOTS } from "../lib/config.ts";

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class GitError extends S.TaggedError<GitError>()("GitError", {
  command: S.String,
  message: S.String,
  code: S.NullOr(S.Number),
}) {}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const barePath = (name: string) => deploymentPaths(name, "", DEPLOYMENT_ROOTS).bareRepo;
const worktreePath = (name: string, stage: string) =>
  deploymentPaths(name, stage, DEPLOYMENT_ROOTS).worktree;

/** Build the only git command used to remove a deployment worktree. */
export const removeWorktreeArgs = (name: string, stage: string): ReadonlyArray<string> => [
  "-C",
  barePath(name),
  "worktree",
  "remove",
  "--force",
  worktreePath(name, stage),
];

export const sanitizeRef = (ref: string): string =>
  ref
    .replace(/^refs\/(heads|remotes\/origin)\//, "")
    .replace(/[^a-zA-Z0-9-]/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-|-$/g, "");

const mkdirp = (dir: string) =>
  Command.make("mkdir", "-p", dir).pipe(
    Command.exitCode,
    Effect.scoped,
    Effect.provide(BunContext.layer),
    Effect.mapError(
      (error) => new GitError({ command: `mkdir -p ${dir}`, message: error.message, code: null }),
    ),
    Effect.filterOrFail(
      (exitCode) => exitCode === 0,
      () =>
        new GitError({
          command: `mkdir -p ${dir}`,
          message: "Failed to create directory",
          code: null,
        }),
    ),
    Effect.asVoid,
  );

const readAll = (stream: Stream.Stream<Uint8Array, unknown>) =>
  Stream.decodeText(stream).pipe(
    Stream.runFold("", (acc, chunk) => acc + chunk),
    Effect.orElseSucceed(() => ""),
  );

const git = (args: ReadonlyArray<string>, cwd?: string) =>
  Effect.gen(function* () {
    const process = yield* Command.make("git", ...args).pipe(
      cwd !== undefined ? Command.workingDirectory(cwd) : (c) => c,
      Command.env({ GIT_TERMINAL_PROMPT: "0" }),
      Command.start,
    );
    const [stdout, stderr, exitCode] = yield* Effect.all(
      [readAll(process.stdout), readAll(process.stderr), process.exitCode],
      { concurrency: "unbounded" },
    );
    if (exitCode !== 0) {
      return yield* new GitError({
        command: `git ${args.join(" ")}`,
        message: stderr.trim(),
        code: exitCode,
      });
    }
    return stdout.trim();
  }).pipe(
    Effect.scoped,
    Effect.catchTags({
      SystemError: (error) =>
        new GitError({ command: `git ${args.join(" ")}`, message: error.message, code: null }),
      BadArgument: (error) =>
        new GitError({ command: `git ${args.join(" ")}`, message: error.message, code: null }),
    }),
    Effect.provide(BunContext.layer),
  );

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export class GitManager extends Effect.Service<GitManager>()("infra/GitManager", {
  succeed: {
    repository: {
      ensure: Effect.fnUntraced(function* (name: string, repoUrl?: string) {
        const repo = barePath(name);
        const exists = yield* git(["rev-parse", "--is-bare-repository"], repo).pipe(
          Effect.map((out) => out === "true"),
          Effect.orElseSucceed(() => false),
        );

        if (exists) return;

        const url = repoUrl ?? `${GIT_HOST}/${name}.git`;
        yield* mkdirp(PROJECTS_DIR);
        yield* git(["clone", "--bare", url, repo]);
        // bare clones lack a fetch refspec — add one so `fetch --all` updates local refs
        yield* git(["-C", repo, "config", "remote.origin.fetch", "+refs/heads/*:refs/heads/*"]);
      }),

      fetch: (name: string) =>
        Effect.gen(function* () {
          // ensure fetch refspec exists (bare clones created before this fix lack it)
          yield* git([
            "-C",
            barePath(name),
            "config",
            "remote.origin.fetch",
            "+refs/heads/*:refs/heads/*",
          ]).pipe(Effect.catchAll(() => Effect.void));
          yield* git(["-C", barePath(name), "fetch", "--all", "--prune"]);
        }).pipe(Effect.asVoid),

      resolveRef: (name: string, ref: string) =>
        git(["-C", barePath(name), "rev-parse", "--short", ref]),

      defaultBranch: (name: string) =>
        git(["-C", barePath(name), "symbolic-ref", "HEAD"]).pipe(
          Effect.map((out) => out.replace(/^refs\/heads\//, "")),
        ),
    },

    worktrees: {
      add: Effect.fnUntraced(function* (name: string, stage: string, ref: string) {
        const wt = worktreePath(name, stage);

        yield* git(["-C", barePath(name), "worktree", "remove", "--force", wt]).pipe(
          Effect.catchAll(() => Effect.void),
        );

        yield* mkdirp(worktreeParent(name, DEPLOYMENT_ROOTS));

        yield* git(["-C", barePath(name), "worktree", "add", "--detach", wt, ref]);
        return wt;
      }),

      remove: (name: string, stage: string) =>
        git([...removeWorktreeArgs(name, stage)]).pipe(Effect.asVoid),
    },
  },
}) {}
