/**
 * `alchemy-runner submit` queues one request and prints its id; `alchemy-runner wait <id>`
 * streams the job unit's journal until the job ends and exits with its code. SIGINT during
 * wait cancels a job that is still queued or starting.
 */
import { Console, Effect, Fiber, Option, Ref, Runtime, Schema as S, Stream } from "effect";
import { ChildProcess } from "effect/process";
import { ChildProcessSpawner } from "effect/process/ChildProcessSpawner";
import { request } from "./Client.ts";
import { QueueProtocolError } from "./Errors.ts";
import { production } from "./Paths.ts";
import { Submit } from "./Protocol.ts";
import { unitName } from "./Schema.ts";

/** Process exit for a finished job; 1 when the terminal state has no exit code. */
export class SubmitExit extends S.TaggedError<SubmitExit>()("SubmitExit", {
  code: S.Number,
}) {
  readonly [Runtime.errorReported] = false;
  get [Runtime.errorExitCode]() {
    return this.code;
  }
}

const decodeSubmit = S.decodeUnknownEffect(S.fromJsonString(Submit));

/** Queue the job that `text`, one JSON submit request, describes; return its id. */
export const submitJob = Effect.fn("queue.submitJob")(function* (
  text: string,
  socketPath: string = production.socket,
) {
  const body = yield* decodeSubmit(text).pipe(
    Effect.mapError(
      (error) => new QueueProtocolError({ message: `invalid submit request: ${error.message}` }),
    ),
  );
  const submitted = yield* request(socketPath, body);
  if (submitted._tag === "error")
    return yield* new QueueProtocolError({ message: submitted.message });
  if (submitted._tag !== "submitted") {
    return yield* new QueueProtocolError({ message: `unexpected response ${submitted._tag}` });
  }
  return submitted.id;
});

const exitCodeOf = (state: string, exitCode: number | null): number => {
  if (exitCode !== null) return exitCode;
  return state === "succeeded" ? 0 : 1;
};

/** The journal fields this client reads. MESSAGE is a byte array when it is not UTF-8. */
const JournalEntry = S.fromJsonString(
  S.Struct({
    __CURSOR: S.String,
    MESSAGE: S.optional(S.Union([S.String, S.Array(S.Number)])),
  }),
);
const decodeEntry = S.decodeUnknownOption(JournalEntry);

/**
 * Print the job unit's own output (not systemd's lines about the unit) after `cursor`, or
 * from its first line. With `follow`, keep printing until interrupted. Each printed entry
 * moves `cursor`, so a later call prints exactly the rest.
 */
const printJournal = (unit: string, cursor: Ref.Ref<Option.Option<string>>, follow: boolean) =>
  Effect.scoped(
    Effect.gen(function* () {
      const after = Option.match(yield* Ref.get(cursor), {
        onNone: () => [],
        onSome: (value) => [`--after-cursor=${value}`],
      });
      const spawner = yield* ChildProcessSpawner;
      const handle = yield* spawner.spawn(
        ChildProcess.make(
          "journalctl",
          [`_SYSTEMD_UNIT=${unit}`, "-o", "json", ...after, ...(follow ? ["-f", "-n", "all"] : [])],
          { stdout: "pipe", stderr: "ignore" },
        ),
      );
      yield* Effect.addFinalizer(() => handle.kill({ killSignal: "SIGTERM" }).pipe(Effect.ignore));
      yield* Stream.decodeText(handle.stdout).pipe(
        Stream.splitLines,
        Stream.runForEach((line) =>
          Option.match(decodeEntry(line), {
            onNone: () => Effect.void,
            onSome: (entry) =>
              Effect.andThen(
                Ref.set(cursor, Option.some(entry.__CURSOR)),
                Effect.sync(() => {
                  const message = entry.MESSAGE ?? "";
                  process.stdout.write(
                    `${typeof message === "string" ? message : Buffer.from(message).toString()}\n`,
                  );
                }),
              ),
          }),
        ),
      );
    }),
  );

/**
 * Ask the front end to cancel job `id`. A running job refuses, so say how to follow it.
 * Runs as an interrupt finalizer: it cannot fail, and the interrupt still ends the process.
 */
const cancelOrFollow = (socketPath: string, id: number, unit: string) =>
  request(socketPath, { _tag: "cancel", id }).pipe(
    Effect.flatMap((response) =>
      response._tag === "canceled"
        ? Console.error(`job ${id} canceled.`)
        : Console.error(
            [
              `job ${id} keeps running (cancel refused while running).`,
              `Follow it with: journalctl _SYSTEMD_UNIT=${unit} -f -o cat`,
            ].join("\n"),
          ),
    ),
    Effect.ignore,
  );

/**
 * Follow job `id`'s unit journal until the job ends, then fail with SubmitExit carrying its
 * code. On interrupt (SIGINT), cancel the job when it has not started.
 */
export const waitJob = Effect.fn("queue.waitJob")(function* (
  id: number,
  socketPath: string = production.socket,
) {
  const unit = unitName(id);

  const cursor = yield* Ref.make(Option.none<string>());
  const journal = yield* Effect.forkDetach(printJournal(unit, cursor, true).pipe(Effect.ignore));
  const waited = yield* request(socketPath, { _tag: "wait", id }).pipe(
    Effect.onInterrupt(() => cancelOrFollow(socketPath, id, unit)),
    Effect.ensuring(Fiber.interrupt(journal)),
  );
  // The follower stops wherever it was; print the lines it had not reached.
  yield* printJournal(unit, cursor, false).pipe(Effect.ignore);

  if (waited._tag === "error") {
    return yield* new QueueProtocolError({ message: waited.message });
  }
  if (waited._tag !== "waited") {
    return yield* new QueueProtocolError({
      message: `unexpected response ${waited._tag}`,
    });
  }
  return yield* new SubmitExit({
    code: exitCodeOf(waited.state, waited.exitCode),
  });
});
