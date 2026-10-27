/**
 * ExecStopPost hook: on every alchemy-job@ exit, finalise a stuck row and ask the front
 * end to start the next job. The job body never sends `next` itself.
 */
import { Config, Effect, Option } from "effect";
import { request } from "./Client.ts";
import type { Paths } from "./Paths.ts";
import { Store } from "./Store.ts";

/** systemd SERVICE_RESULT values that mean the process was killed or timed out. */
const interruptedResults = new Set([
  "signal",
  "core-dump",
  "timeout",
  "exit-signal",
  "watchdog",
  "oom-kill",
]);

/**
 * When the row is still queued, starting, or running, mark it failed (or interrupted when
 * SERVICE_RESULT says killed/signal), then send `next` on the submit socket.
 * A failed `next` fails this hook so journald records it; the front end also runs
 * tryStart on a schedule so progress never depends on one notification.
 */
export const finished = Effect.fn("queue.finished")(function* (id: number, paths: Paths) {
  const store = yield* Store;
  const job = yield* store.getOption(id);
  if (
    Option.isSome(job) &&
    (job.value.state === "queued" ||
      job.value.state === "starting" ||
      job.value.state === "running")
  ) {
    const result = yield* Config.option(Config.String("SERVICE_RESULT"));
    const interrupted = Option.isSome(result) && interruptedResults.has(result.value.toLowerCase());
    yield* store.abandon(id, interrupted ? "interrupted" : "failed", 1);
  }
  yield* request(paths.socket, { _tag: "next" }).pipe(Effect.asVoid);
});
