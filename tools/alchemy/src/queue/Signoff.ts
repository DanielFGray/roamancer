/**
 * `alchemy-runner signoff` stores one record from a JSON line on stdin; `alchemy-runner
 * signoffs <app>` prints that app's rows as JSON. Neither is a job.
 */
import { Console, Effect, Schema as S } from "effect";
import { request } from "./Client.ts";
import { QueueProtocolError } from "./Errors.ts";
import { production } from "./Paths.ts";
import { Signoff, Signoffs } from "./Protocol.ts";

const decodeSignoff = S.decodeUnknownEffect(S.fromJsonString(Signoff));

/** Store the signoff that `text` describes; return its id. */
export const recordSignoff = Effect.fn("queue.recordSignoff")(function* (
  text: string,
  socketPath: string = production.socket,
) {
  const body = yield* decodeSignoff(text).pipe(
    Effect.mapError(
      (error) => new QueueProtocolError({ message: `invalid signoff request: ${error.message}` }),
    ),
  );
  const response = yield* request(socketPath, body);
  if (response._tag === "error")
    return yield* new QueueProtocolError({ message: response.message });
  if (response._tag !== "signedOff") {
    return yield* new QueueProtocolError({ message: `unexpected response ${response._tag}` });
  }
  return response.id;
});

/** Print the app's signoffs as one JSON array on stdout. */
export const printSignoffs = Effect.fn("queue.printSignoffs")(function* (
  app: string,
  socketPath: string = production.socket,
) {
  const response = yield* request(socketPath, { _tag: "signoffs", app } satisfies Signoffs);
  if (response._tag === "error")
    return yield* new QueueProtocolError({ message: response.message });
  if (response._tag !== "signoffsListed") {
    return yield* new QueueProtocolError({ message: `unexpected response ${response._tag}` });
  }
  yield* Console.log(JSON.stringify(response.signoffs));
});
