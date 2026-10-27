/**
 * Reserve the oldest queued job in the database, then start its unit.
 * Exclusion is the atomic reservation — unit process state is not consulted.
 */
import { Effect, Option } from "effect";
import { Store } from "./Store.ts";
import { Units } from "./Units.ts";

/**
 * Returns the id that was reserved and started, or none when the queue is empty
 * or another job is already starting/running.
 */
export const tryStart = Effect.fn("queue.tryStart")(function* () {
  const store = yield* Store;
  const units = yield* Units;
  const reserved = yield* store.reserveNext();
  if (Option.isNone(reserved)) return Option.none<number>();
  yield* units.start(reserved.value.id);
  return Option.some(reserved.value.id);
});
