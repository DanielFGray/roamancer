/**
 * `alchemy-runner job run <id>`: claim the reserved row, run the submitted command, store
 * the exit code. Does not start the next job — ExecStopPost (`job finished`) does that.
 */
import { Effect, FileSystem, Schema as S } from "effect";
import type { ChildProcessSpawner } from "effect/process/ChildProcessSpawner";
import { JobNotFound, JobNotStarting, LoginRequired } from "./Errors.ts";
import type { Paths } from "./Paths.ts";
import type { Job } from "./Schema.ts";
import { Store } from "./Store.ts";

/** Exit code from a failed Alchemy run; matched by `_tag` only. */
export class JobExit extends S.TaggedError<JobExit>()("JobExit", {
  code: S.Number,
}) {}

/** Operator-facing failure from the host command path; matched by `_tag` only. */
export class JobCommandError extends S.TaggedError<JobCommandError>()("JobCommandError", {
  message: S.String,
}) {}

export type Execute = (
  job: Job,
  env: Record<string, string>,
) => Effect.Effect<
  void,
  LoginRequired | JobExit | JobCommandError,
  FileSystem.FileSystem | ChildProcessSpawner
>;

const readToken = (paths: Paths) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const text = yield* fs.readFileString(paths.tokenFile).pipe(
      Effect.map((value) => value.trim()),
      Effect.catchTag("PlatformError", () => new LoginRequired()),
    );
    if (text === "") return yield* new LoginRequired();
    return text;
  });

/**
 * Run one queued job. The row must already be `starting` (reserved by tryStart).
 * Missing token abandons the row as failed before exiting. A canceled reservation
 * fails claim and never runs Alchemy. Cartridge JSON is a scoped temp file.
 */
export const runJob = Effect.fn("queue.runJob")(function* (
  id: number,
  paths: Paths,
  execute: Execute,
) {
  const store = yield* Store;
  const fs = yield* FileSystem.FileSystem;

  yield* store.get(id).pipe(Effect.catchTag("JobNotFound", () => new JobNotFound({ id })));

  const token = yield* readToken(paths).pipe(
    Effect.tapErrorTag("LoginRequired", () => store.abandon(id, "failed", 1)),
  );

  const marked = yield* store
    .claim(id)
    .pipe(Effect.catchTag("JobNotStarting", (error) => new JobNotStarting(error)));

  const env: Record<string, string> = {
    OPENBAO_TOKEN: token,
    OPENBAO_TOKEN_FILE: paths.tokenFile,
  };

  yield* Effect.scoped(
    Effect.gen(function* () {
      const cartridge = marked.submit.command === "rollback" ? null : marked.submit.cartridge;
      if (cartridge !== null && marked.submit.command !== "rollback") {
        const cartridgeFile = yield* fs.makeTempFileScoped();
        yield* fs.writeFileString(cartridgeFile, cartridge, { mode: 0o600 });
        env.CARTRIDGE_FILE = cartridgeFile;
        env.ORIGIN = marked.submit.origin;
        env.REVISION = marked.submit.revision;
      }

      const outcome = yield* execute(marked, env).pipe(
        Effect.as(0),
        Effect.catchTag("JobExit", (error) => Effect.succeed(error.code)),
        Effect.catchTag("LoginRequired", () =>
          Effect.gen(function* () {
            yield* store.finish(id, 1);
            return yield* new LoginRequired();
          }),
        ),
        Effect.catchTag("JobCommandError", (error) =>
          Effect.gen(function* () {
            yield* store.finish(id, 1);
            return yield* error;
          }),
        ),
      );

      yield* store.finish(id, outcome);
      if (outcome !== 0) return yield* new JobExit({ code: outcome });
    }),
  );
});
