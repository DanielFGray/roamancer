import { Effect, Schema as S } from "effect"
import { spawn } from "bun"
import { PROJECTS_DIR, GIT_HOST } from "../lib/config.ts"

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

const barePath = (name: string) => `${PROJECTS_DIR}/${name}.git`
const stagesDir = (name: string) => `${PROJECTS_DIR}/${name}/stages`
const worktreePath = (name: string, stage: string) => `${stagesDir(name)}/${stage}`

export const sanitizeRef = (ref: string): string =>
  ref
    .replace(/^refs\/(heads|remotes\/origin)\//, "")
    .replace(/[^a-zA-Z0-9-]/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-|-$/g, "")

const git = (args: string[], cwd?: string): Effect.Effect<string, GitError> =>
  Effect.gen(function* () {
    const proc = yield* Effect.try({
      try: () =>
        spawn({
          cmd: ["git", ...args],
          ...(cwd !== undefined ? { cwd } : {}),
          stdout: "pipe",
          stderr: "pipe",
          env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
        }),
      catch: (err) =>
        new GitError({
          command: `git ${args.join(" ")}`,
          message: String(err),
          code: null,
        }),
    })

    const stdout = yield* Effect.promise(() => proc.stdout.text())
    const exitCode = yield* Effect.promise(() => proc.exited)

    if (exitCode !== 0) {
      const stderr = yield* Effect.promise(() => proc.stderr.text())
      return yield* new GitError({
        command: `git ${args.join(" ")}`,
        message: stderr.trim(),
        code: exitCode,
      })
    }

    return stdout.trim()
  })

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export class GitManager extends Effect.Service<GitManager>()("infra/GitManager", {
  succeed: {
    ensureRepo: (name: string, repoUrl?: string) =>
      Effect.gen(function* () {
        const repo = barePath(name)
        const exists = yield* git(["rev-parse", "--is-bare-repository"], repo).pipe(
          Effect.map((out) => out === "true"),
          Effect.catchAll(() => Effect.succeed(false)),
        )

        if (exists) return

        const url = repoUrl ?? `${GIT_HOST}/${name}.git`
        yield* Effect.sync(() => {
          const proc = Bun.spawnSync(["mkdir", "-p", PROJECTS_DIR])
          if (proc.exitCode !== 0) throw new Error("Failed to create projects dir")
        })
        yield* git(["clone", "--bare", url, repo])
        // bare clones lack a fetch refspec — add one so `fetch --all` updates local refs
        yield* git(["-C", repo, "config", "remote.origin.fetch", "+refs/heads/*:refs/heads/*"])
      }),

    fetch: (name: string) =>
      Effect.gen(function* () {
        // ensure fetch refspec exists (bare clones created before this fix lack it)
        yield* git(["-C", barePath(name), "config", "remote.origin.fetch", "+refs/heads/*:refs/heads/*"]).pipe(
          Effect.catchAll(() => Effect.void),
        )
        yield* git(["-C", barePath(name), "fetch", "--all", "--prune"])
      }).pipe(Effect.asVoid),

    addWorktree: (name: string, stage: string, ref: string) =>
      Effect.gen(function* () {
        const wt = worktreePath(name, stage)

        yield* git(["-C", barePath(name), "worktree", "remove", "--force", wt]).pipe(
          Effect.catchAll(() => Effect.void),
        )

        yield* Effect.sync(() => {
          Bun.spawnSync(["mkdir", "-p", stagesDir(name)])
        })

        yield* git(["-C", barePath(name), "worktree", "add", "--detach", wt, ref])
        return wt
      }),

    removeWorktree: (name: string, stage: string) =>
      git(["-C", barePath(name), "worktree", "remove", "--force", worktreePath(name, stage)]).pipe(
        Effect.asVoid,
      ),

    resolveRef: (name: string, ref: string) =>
      git(["-C", barePath(name), "rev-parse", "--short", ref]),

    defaultBranch: (name: string) =>
      git(["-C", barePath(name), "symbolic-ref", "HEAD"]).pipe(
        Effect.map((out) => out.replace(/^refs\/heads\//, "")),
      ),
  },
}) {}
