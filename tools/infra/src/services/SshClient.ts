import { Effect, Schema as S, Stream } from "effect";
import * as Command from "@effect/platform/Command";
import { BunContext } from "@effect/platform-bun";

// ---------------------------------------------------------------------------
// Error types
// ---------------------------------------------------------------------------

export class SshError extends S.TaggedError<SshError>()("SshError", {
  code: S.NullOr(S.Number),
  signal: S.NullOr(S.String),
  message: S.String,
}) {}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const target = (host: string, user?: string) => (user ? `${user}@${host}` : host);
const shellQuote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

const readAll = (stream: Stream.Stream<Uint8Array, unknown>) =>
  Stream.decodeText(stream).pipe(
    Stream.runFold("", (acc, chunk) => acc + chunk),
    Effect.orElseSucceed(() => ""),
  );

const asSshError = (describe: string) =>
  Effect.catchTags({
    SystemError: (error: { message: string }) =>
      new SshError({ code: null, signal: null, message: `${describe}: ${error.message}` }),
    BadArgument: (error: { message: string }) =>
      new SshError({ code: null, signal: null, message: `${describe}: ${error.message}` }),
  });

/** Run a command, capturing stdout/stderr, mapping any failure to SshError. */
const run = (command: Command.Command, describe: string) =>
  Effect.gen(function* () {
    const process = yield* Command.start(command);
    const [stdout, stderr, exitCode] = yield* Effect.all(
      [readAll(process.stdout), readAll(process.stderr), process.exitCode],
      { concurrency: "unbounded" },
    );
    if (exitCode !== 0) {
      return yield* new SshError({
        code: exitCode,
        signal: null,
        message: `${describe}: ${stderr.trim()}`,
      });
    }
    return stdout;
  }).pipe(Effect.scoped, asSshError(describe), Effect.provide(BunContext.layer));

/** Same as `run`, but streams stdin/stdout/stderr to the parent's TTY (for sudo, etc). */
const runInteractive = (command: Command.Command, describe: string) =>
  command.pipe(
    Command.stdin("inherit"),
    Command.stdout("inherit"),
    Command.stderr("inherit"),
    Command.exitCode,
    Effect.flatMap((exitCode) =>
      exitCode === 0
        ? Effect.void
        : Effect.fail(
            new SshError({
              code: exitCode,
              signal: null,
              message: `${describe}: exited ${exitCode}`,
            }),
          ),
    ),
    Effect.scoped,
    asSshError(describe),
    Effect.provide(BunContext.layer),
  );

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export class SshClient extends Effect.Service<SshClient>()("infra/SshClient", {
  succeed: {
    exec: (host: string, command: string, user?: string) => {
      const dest = target(host, user);
      return run(Command.make("ssh", dest, `bash -lc ${shellQuote(command)}`), `ssh ${dest}`);
    },

    /** Write content to a remote file via base64 pipe (immune to heredoc injection) */
    writeFile: (
      host: string,
      remotePath: string,
      content: string,
      opts?: { mode?: string; user?: string },
    ) => {
      const b64 = Buffer.from(content).toString("base64");
      const decode = `echo '${b64}' | base64 -d`;
      const write = `${decode} > ${remotePath}`;
      const chmod = opts?.mode ? ` && chmod ${opts.mode} ${remotePath}` : "";
      const dest = target(host, opts?.user);
      const cmd = `${write}${chmod}`;
      return run(
        Command.make("ssh", dest, `bash -lc ${shellQuote(cmd)}`),
        `ssh ${dest} writeFile`,
      ).pipe(Effect.asVoid);
    },

    /** Run a command interactively with TTY (for sudo, etc.) */
    execInteractive: (host: string, command: string, user?: string) => {
      const dest = target(host, user);
      return runInteractive(
        Command.make("ssh", "-t", dest, `bash -lc ${shellQuote(command)}`),
        `ssh ${dest}`,
      );
    },

    rsync: (source: string, dest: string, host: string, user?: string) => {
      const remoteDest = `${target(host, user)}:${dest}`;
      return run(Command.make("rsync", "-a", "--delete", source, remoteDest), "rsync").pipe(
        Effect.asVoid,
      );
    },
  },
}) {}
