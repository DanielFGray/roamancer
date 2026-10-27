/**
 * One JSON-line request over the submit socket.
 */
import * as BunSocket from "@effect/platform-bun/BunSocket";
import { Effect, Schema as S } from "effect";
import * as Socket from "effect/socket/Socket";
import { QueueProtocolError } from "./Errors.ts";
import { Request, Response } from "./Protocol.ts";

const decodeResponse = S.decodeUnknownEffect(S.fromJsonString(Response));
const encodeRequest = S.encodeUnknownEffect(S.fromJsonString(Request));

/** Dial `socketPath`, send one request line, read one response line. */
export const request = (
  socketPath: string,
  body: Request,
): Effect.Effect<Response, QueueProtocolError | Socket.SocketError | S.SchemaError> =>
  Effect.scoped(
    Effect.gen(function* () {
      const socket = yield* BunSocket.makeNet({ path: socketPath });
      // Acquiring the reader dials the connection; write after that.
      const pull = yield* Socket.readerString(socket);
      const writer = yield* socket.writer;
      const line = yield* encodeRequest(body);
      yield* writer.write(`${line}\n`);
      let buffer = "";
      while (!buffer.includes("\n")) {
        const batch = yield* pull;
        buffer += batch.join("");
      }
      return yield* decodeResponse(buffer.slice(0, buffer.indexOf("\n")));
    }),
  );
