/**
 * `alchemy-runner build`: forward stdin to the submit socket and print the id of the build job
 * it queues. Stdin is one build request line followed by the tar the line's `size` counts.
 * The command does not read the bytes: the front end validates the line and stores the tar as
 * the alchemy user, which the operator who runs this command cannot be.
 */
import * as BunSocket from "@effect/platform-bun/BunSocket";
import { Effect, Schema as S, Stream } from "effect";
import * as Socket from "effect/socket/Socket";
import { QueueProtocolError } from "./Errors.ts";
import { Response } from "./Protocol.ts";

const decodeResponse = S.decodeUnknownEffect(S.fromJsonString(Response));

export const forwardBuild = <E>(input: Stream.Stream<Uint8Array, E>, socketPath: string) =>
  Effect.scoped(
    Effect.gen(function* () {
      const socket = yield* BunSocket.makeNet({ path: socketPath });
      const pull = yield* Socket.readerString(socket);
      const writer = yield* socket.writer;
      yield* Stream.runForEach(input, (chunk) => writer.write(chunk));
      let buffer = "";
      while (!buffer.includes("\n")) buffer += (yield* pull).join("");
      const answer = yield* decodeResponse(buffer.slice(0, buffer.indexOf("\n")));
      if (answer._tag === "error")
        return yield* new QueueProtocolError({ message: answer.message });
      if (answer._tag !== "submitted") {
        return yield* new QueueProtocolError({ message: `unexpected response ${answer._tag}` });
      }
      return answer.id;
    }),
  );
