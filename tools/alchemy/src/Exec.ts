/**
 * Child processes for the workstation commands. A non-zero exit and a program that cannot
 * start are both an OpsError, so `ops` prints one line and no stack trace.
 */
import { Effect, Runtime, Schema as S, Stream } from "effect";
import type { PlatformError } from "effect/PlatformError";
import { ChildProcess } from "effect/process";
import { ChildProcessSpawner } from "effect/process/ChildProcessSpawner";

/** A failure the operator can act on, printed without a stack trace. */
export class OpsError extends S.TaggedError<OpsError>()("OpsError", { message: S.String }) {
  readonly [Runtime.errorReported] = false;
}

/** Run a program on this terminal; fails unless it exits 0. `env` is added to ours. */
export const run = Effect.fn("Exec.run")(function* (
  command: string,
  args: ReadonlyArray<string>,
  env?: Record<string, string>,
) {
  const spawner = yield* ChildProcessSpawner;
  const code = yield* spawner
    .exitCode(
      ChildProcess.make(command, args, {
        stdin: "inherit",
        stdout: "inherit",
        stderr: "inherit",
        env,
        extendEnv: env !== undefined,
      }),
    )
    .pipe(Effect.mapError(couldNotStart(command)));
  if (code !== 0) return yield* new OpsError({ message: exited(command, args, code) });
});

/**
 * A program's standard output; its standard error stays on this terminal. `input`, when
 * given, is its standard input: text, or bytes to stream.
 */
export const output = Effect.fn("Exec.output")(function* (
  command: string,
  args: ReadonlyArray<string>,
  input?: string | Stream.Stream<Uint8Array, PlatformError>,
  env?: Record<string, string>,
) {
  const spawner = yield* ChildProcessSpawner;
  const stdin = typeof input === "string" ? Stream.make(new TextEncoder().encode(input)) : input;
  const handle = yield* spawner
    .spawn(
      ChildProcess.make(command, args, {
        stdin,
        stderr: "inherit",
        env,
        extendEnv: env !== undefined,
      }),
    )
    .pipe(Effect.mapError(couldNotStart(command)));
  const text = yield* Stream.mkString(Stream.decodeText(handle.stdout)).pipe(
    Effect.mapError(couldNotStart(command)),
  );
  const code = yield* handle.exitCode.pipe(Effect.mapError(couldNotStart(command)));
  if (code !== 0) return yield* new OpsError({ message: exited(command, args, code) });
  return text;
}, Effect.scoped);

/** Whether a program exits 0, with its output discarded. */
export const succeeds = Effect.fn("Exec.succeeds")(function* (
  command: string,
  args: ReadonlyArray<string>,
) {
  const spawner = yield* ChildProcessSpawner;
  const code = yield* spawner
    .exitCode(ChildProcess.make(command, args, { stdout: "ignore", stderr: "ignore" }))
    .pipe(Effect.mapError(couldNotStart(command)));
  return code === 0;
});

/** Quote one word for the remote shell that `ssh` hands its command line to. */
export const quote = (word: string) => `'${word.replaceAll("'", `'\\''`)}'`;

/**
 * Insert `--` after a command whose flags the tree does not declare, so they pass on unread.
 * `names` are the commands that forward the rest of the argv.
 */
export const route =
  (names: ReadonlyArray<string>) =>
  (args: ReadonlyArray<string>): ReadonlyArray<string> => {
    const [name, ...rest] = args;
    if (name === undefined) return args;
    const forwarded = names.includes(name);
    return forwarded && rest[0] !== "--" ? [name, "--", ...rest] : args;
  };

const exited = (command: string, args: ReadonlyArray<string>, code: number) =>
  `${command} ${args.join(" ")} exited ${code}`;

const couldNotStart = (command: string) => (error: PlatformError) =>
  new OpsError({ message: `${command}: ${error.message}` });
