import type { LogLine } from "alchemy/Provider";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import * as Result from "effect/Result";

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
