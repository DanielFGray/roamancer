/**
 * Queue front end: one JSON-line request per connection on the submit socket.
 * It binds the socket path itself. Under systemd socket activation, Bun reports an
 * inherited unix socket's address as `{}`, and Effect's socket server fails on it.
 */
import * as BunSocketServer from "@effect/platform-bun/BunSocketServer";
import { Effect, FileSystem, Layer, Option, Schedule, Schema as S } from "effect";
import * as Socket from "effect/socket/Socket";
import * as SocketServer from "effect/socket/SocketServer";
import { QueueProtocolError, TokenWriteError } from "./Errors.ts";
import type { Paths } from "./Paths.ts";
import { Request, Response } from "./Protocol.ts";
import { unitName } from "./Schema.ts";
import { tryStart } from "./Starter.ts";
import { Store } from "./Store.ts";

const decodeRequest = S.decodeUnknownEffect(S.fromJsonString(Request));
const encodeResponse = S.encodeUnknownEffect(S.fromJsonString(Response));

const terminal = new Set(["succeeded", "failed", "interrupted", "canceled"]);

/** On start, interrupt every starting/running row and enqueue a plan per stage — one txn. */
export const recover = Effect.fn("queue.recover")(function* () {
  const store = yield* Store;
  yield* store.recoverInterrupted();
});

const waitFor = (id: number) =>
  Effect.gen(function* () {
    const store = yield* Store;
    const job = yield* store.getOption(id);
    if (Option.isNone(job)) {
      return yield* new QueueProtocolError({ message: `no job ${id}` });
    }
    if (terminal.has(job.value.state)) return job.value;
    return yield* new QueueProtocolError({ message: "waiting" });
  }).pipe(
    Effect.retry({
      schedule: Schedule.spaced("50 millis"),
      while: (error) => error._tag === "QueueProtocolError" && error.message === "waiting",
    }),
  );

const storeToken = (paths: Paths, value: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const temp = `${paths.tokenFile}.tmp`;
    // Never log the token value. Write 0600 to a sibling temp file, then rename.
    yield* fs
      .writeFileString(temp, value, { mode: 0o600 })
      .pipe(Effect.mapError((error) => new TokenWriteError({ message: error.message })));
    yield* fs
      .rename(temp, paths.tokenFile)
      .pipe(Effect.mapError((error) => new TokenWriteError({ message: error.message })));
  });

const fulfill = (paths: Paths, request: Request) =>
  Effect.gen(function* () {
    const store = yield* Store;
    switch (request._tag) {
      case "submit": {
        const { _tag, ...submit } = request;
        const job = yield* store.enqueue(submit);
        yield* tryStart();
        return { _tag: "submitted" as const, id: job.id };
      }
      case "list":
        return { _tag: "listed" as const, jobs: yield* store.list() };
      case "show": {
        const job = yield* store.getOption(request.id);
        if (Option.isNone(job)) {
          return { _tag: "error" as const, message: `no job ${request.id}` };
        }
        return {
          _tag: "shown" as const,
          job: job.value,
          unit: unitName(job.value.id),
        };
      }
      case "wait": {
        const ended = yield* waitFor(request.id);
        return {
          _tag: "waited" as const,
          id: ended.id,
          state: ended.state,
          exitCode: ended.exitCode,
        };
      }
      case "cancel": {
        return yield* store.cancel(request.id).pipe(
          Effect.map((job) => ({ _tag: "canceled" as const, job })),
          Effect.catchTag("CancelRefused", (error) =>
            Effect.succeed({ _tag: "error" as const, message: error.message }),
          ),
          Effect.catchTag("JobNotFound", (error) =>
            Effect.succeed({ _tag: "error" as const, message: error.message }),
          ),
        );
      }
      case "token": {
        yield* storeToken(paths, request.value);
        return { _tag: "tokenStored" as const };
      }
      case "next": {
        const started = yield* tryStart();
        return {
          _tag: "next" as const,
          started: Option.getOrNull(started),
        };
      }
    }
  });

const handleConnection = (paths: Paths, socket: Socket.Socket) =>
  Effect.scoped(
    Effect.gen(function* () {
      const pull = yield* Socket.readerString(socket);
      let buffer = "";
      while (!buffer.includes("\n")) {
        const batch = yield* pull;
        buffer += batch.join("");
      }
      const line = buffer.slice(0, buffer.indexOf("\n"));
      const response: Response = yield* decodeRequest(line).pipe(
        Effect.flatMap((request) => fulfill(paths, request)),
        Effect.catch((error: unknown) =>
          Effect.succeed({
            _tag: "error" as const,
            message: error instanceof Error ? error.message : String(error),
          }),
        ),
      );
      const writer = yield* socket.writer;
      const encoded = yield* encodeResponse(response);
      yield* writer.write(`${encoded}\n`);
    }),
  ).pipe(
    Effect.catch((error) =>
      Effect.logWarning("queue connection failed").pipe(
        Effect.annotateLogs({ error: String(error) }),
      ),
    ),
  );

/** Recover, tryStart, accept connections; also tryStart every 30s so a missed next cannot stall. */
export const serve = (paths: Paths) =>
  Effect.gen(function* () {
    yield* recover();
    yield* tryStart();
    yield* Effect.repeat(tryStart(), Schedule.spaced("30 seconds")).pipe(
      Effect.forkDetach,
      Effect.asVoid,
    );
    const server = yield* SocketServer.SocketServer;
    yield* server.run((socket) => handleConnection(paths, socket));
  });

/**
 * The submit socket server. A crash or kill leaves the socket file behind, and binding
 * over it fails with EADDRINUSE, so remove it first; systemd runs one front end at a time.
 */
export const layerServer = (paths: Paths) =>
  Layer.unwrap(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      yield* fs.remove(paths.socket, { force: true });
      return BunSocketServer.layer({ path: paths.socket });
    }),
  );
