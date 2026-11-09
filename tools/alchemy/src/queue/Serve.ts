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
import { spoolFile, type Paths } from "./Paths.ts";
import { type BuildUpload, Request, Response } from "./Protocol.ts";
import { unitName } from "./Schema.ts";
import { tryStart } from "./Starter.ts";
import { Store } from "./Store.ts";
import type { Units } from "./Units.ts";

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

const fulfill = (paths: Paths, request: Exclude<Request, BuildUpload>) =>
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
      case "findImage": {
        const digest = yield* store.findImage(request);
        return { _tag: "imageFound" as const, digest: Option.getOrNull(digest) };
      }
      case "signoff": {
        const recorded = yield* store.recordSignoff({
          app: request.app,
          tree: request.tree,
          commit: request.commit,
          summary: request.summary,
          logSha256: request.logSha256,
        });
        return { _tag: "signedOff" as const, id: recorded.id };
      }
      case "signoffs": {
        return {
          _tag: "signoffsListed" as const,
          signoffs: yield* store.listSignoffs(request.app),
        };
      }
    }
  });

/**
 * Store the `size` bytes that follow a build request line (`first` holds those already read
 * with the line), then queue the build job. A partial upload is removed, so the spool holds
 * only complete trees.
 */
const receiveBuild = (
  paths: Paths,
  request: BuildUpload,
  first: Uint8Array,
  pull: Effect.Effect<ReadonlyArray<Uint8Array>, Socket.SocketError>,
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const store = yield* Store;
    const spool = crypto.randomUUID();
    const file = spoolFile(paths, spool);
    const partial = `${file}.partial`;
    yield* fs.makeDirectory(paths.spool, { recursive: true, mode: 0o700 });
    yield* Effect.scoped(
      Effect.gen(function* () {
        const out = yield* fs.open(partial, { flag: "w", mode: 0o600 });
        let received = 0;
        const accept = Effect.fnUntraced(function* (chunk: Uint8Array) {
          received += chunk.length;
          if (received > request.size) {
            return yield* new QueueProtocolError({ message: "the upload is longer than its size" });
          }
          yield* out.writeAll(chunk);
        });
        yield* accept(first);
        while (received < request.size) {
          for (const chunk of yield* pull) yield* accept(chunk);
        }
      }),
    ).pipe(Effect.tapError(() => fs.remove(partial, { force: true }).pipe(Effect.ignore)));
    yield* fs.rename(partial, file);
    const job = yield* store.enqueue({
      command: "build",
      repository: request.repository,
      key: request.key,
      spool,
      memoryMaxMB: request.memoryMaxMB,
    });
    yield* tryStart();
    return { _tag: "submitted" as const, id: job.id };
  });

/**
 * Remove spool files that no queued or running build job names: a canceled or interrupted
 * build never reaches its own cleanup.
 */
export const sweepSpool = Effect.fn("queue.sweepSpool")(function* (paths: Paths) {
  const fs = yield* FileSystem.FileSystem;
  const store = yield* Store;
  const live = new Set(
    (yield* store.list())
      .filter((job) => ["queued", "starting", "running"].includes(job.state))
      .flatMap((job) => (job.submit.command === "build" ? [`${job.submit.spool}.tar`] : [])),
  );
  const names = yield* fs.readDirectory(paths.spool).pipe(Effect.orElseSucceed(() => []));
  yield* Effect.forEach(
    names.filter((name) => !live.has(name)),
    (name) => fs.remove(`${paths.spool}/${name}`, { force: true }),
    { discard: true },
  );
});

/** What answering one request needs and may fail with; the connection turns any failure into an error response. */
type Handled = Effect.Effect<Response, unknown, Store | Units | FileSystem.FileSystem>;

const handleConnection = (paths: Paths, socket: Socket.Socket) =>
  Effect.scoped(
    Effect.gen(function* () {
      const pull = yield* Socket.readerBytes(socket);
      // The request line is text; a build request is followed by raw tar bytes, so bytes are
      // read and only the line is decoded.
      let buffered = new Uint8Array(0);
      while (!buffered.includes(10)) {
        const batch = yield* pull;
        buffered = concat([buffered, ...batch]);
      }
      const end = buffered.indexOf(10);
      const line = new TextDecoder().decode(buffered.subarray(0, end));
      const response: Response = yield* decodeRequest(line).pipe(
        Effect.flatMap((request): Handled =>
          request._tag === "build"
            ? receiveBuild(paths, request, buffered.subarray(end + 1), pull)
            : fulfill(paths, request),
        ),
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
    yield* sweepSpool(paths);
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

const concat = (parts: ReadonlyArray<Uint8Array>) => {
  const out = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
};
