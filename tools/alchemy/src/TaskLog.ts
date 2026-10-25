import type { LogLine } from "alchemy/Provider";
import * as Arr from "effect/Array";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Order from "effect/Order";
import * as Result from "effect/Result";
import * as Stream from "effect/Stream";
import type { AllocationSummary, Nomad } from "./Nomad.ts";

/**
 * The last `limit` lines of a Nomad job's current output, oldest first, from both streams of
 * every running task in its newest running allocation.
 */
export const recent = Effect.fn("TaskLog.recent")(function* (
  nomad: typeof Nomad.Service,
  job: string,
  options: { readonly limit?: number; readonly since?: Date },
) {
  const limit = options.limit ?? 100;
  const since = options.since?.getTime() ?? 0;
  const lines = yield* Effect.forEach(yield* sources(nomad, job), (source) =>
    nomad
      .logs(source.allocation, source.task, source.stream, limit * bytesPerLine)
      .pipe(Effect.map((text) => Arr.filterMap(text.split("\n"), parse(source.task)))),
  );
  return Arr.takeRight(
    Arr.sort(
      lines.flat().filter((line) => line.timestamp.getTime() >= since),
      byTimestamp,
    ),
    limit,
  );
});

/** A Nomad job's current output as it is written, from the same tasks as `recent`. */
export const follow = (nomad: typeof Nomad.Service, job: string) =>
  Stream.unwrap(
    sources(nomad, job).pipe(
      Effect.map((list) =>
        Stream.mergeAll(
          list.map((source) =>
            nomad
              .followLogs(source.allocation, source.task, source.stream)
              .pipe(Stream.filterMap(parse(source.task))),
          ),
          { concurrency: "unbounded" },
        ),
      ),
    ),
  );

/**
 * Reads one line of a task log as the Nomad podman driver writes it, in podman's
 * k8s-file format: `<RFC 3339 time> <stdout|stderr> <F|P> <text>`. P marks a line
 * the container wrote without a newline yet; it is shown as its own entry.
 * Fails with the raw text when the line has no such prefix, which happens to the
 * first line of a log read from a byte offset that falls mid-line.
 */
export const parse =
  (task: string) =>
  (text: string): Result.Result<LogLine, string> =>
    Option.fromNullishOr(format.exec(text)).pipe(
      Option.flatMap(([, time = "", stream, message = ""]) =>
        Option.map(DateTime.make(time), (timestamp) => ({
          timestamp: DateTime.toDate(timestamp),
          message: `${task}${stream === "stderr" ? " stderr" : ""}: ${message}`,
        })),
      ),
      Option.match({ onNone: () => Result.fail(text), onSome: Result.succeed }),
    );

const format = /^(\S+) (stdout|stderr) [FP] (.*)$/;

/** A past-log read takes this many bytes from the end of each log per requested line. */
const bytesPerLine = 512;

/**
 * Both output streams of every running task in the job's newest running allocation.
 * Older allocations are replaced deployments, so their logs are not the job's current output.
 */
const sources = Effect.fn("TaskLog.sources")(function* (nomad: typeof Nomad.Service, job: string) {
  const allocations = yield* nomad.allocations(job);
  return Option.match(
    Arr.findFirst(
      Arr.sort(allocations, newestFirst),
      (allocation) => allocation.ClientStatus === "running",
    ),
    {
      onNone: () => [],
      onSome: (allocation) =>
        Object.entries(allocation.TaskStates ?? {})
          .filter(([, state]) => state.State === "running")
          .flatMap(([task]) =>
            (["stdout", "stderr"] as const).map((stream) => ({
              allocation: allocation.ID,
              task,
              stream,
            })),
          ),
    },
  );
});

export const newestFirst = Order.flip(
  Order.mapInput(Order.Number, (allocation: AllocationSummary) => allocation.CreateTime),
);

const byTimestamp = Order.mapInput(Order.Number, (line: LogLine) => line.timestamp.getTime());
