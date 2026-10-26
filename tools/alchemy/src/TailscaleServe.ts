import * as Alchemy from "alchemy";
import * as Provider from "alchemy/Provider";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as S from "effect/Schema";
import { ChildProcess } from "effect/process";
import { ChildProcessSpawner } from "effect/process/ChildProcessSpawner";
import * as Stream from "effect/Stream";

export const TailscaleStatus = S.Struct({
  Self: S.Struct({ DNSName: S.NonEmptyString }),
});
export type TailscaleStatus = typeof TailscaleStatus.Type;

// Tailscale omits TCP and Web when no entry is served, so `{}` means an empty config.
export const ServeStatus = S.Struct({
  TCP: S.Record(S.String.check(S.isPattern(/^[0-9]+$/)), S.Struct({ HTTPS: S.Boolean })).pipe(
    S.withDecodingDefaultKey(Effect.succeed({})),
  ),
  Web: S.Record(
    S.String,
    S.Struct({ Handlers: S.Struct({ "/": S.Struct({ Proxy: S.String }) }) }),
  ).pipe(S.withDecodingDefaultKey(Effect.succeed({}))),
});
export type ServeStatus = typeof ServeStatus.Type;
export type ServeWeb = ServeStatus["Web"];

export const serveOwnership = (web: ServeWeb, port: number, target: string) => {
  const entries = Object.entries(web).filter(([address]) => address.endsWith(`:${port}`));
  const conflict = Arr.findFirst(entries, ([, entry]) => entry.Handlers["/"].Proxy !== target);
  return Option.match(conflict, {
    onSome: ([, entry]) => ({ _tag: "Conflict" as const, target: entry.Handlers["/"].Proxy }),
    onNone: () =>
      Option.match(Arr.head(entries), {
        onNone: () => ({ _tag: "Missing" as const }),
        onSome: () => ({ _tag: "Owned" as const }),
      }),
  });
};

export const servePortRange: { readonly first: number; readonly last: number } = {
  first: 9000,
  last: 9099,
};
export const backendPort = (port: number) => port + 1000;

/** Pick the lowest unused HTTPS Serve port. None means the lease range is exhausted. */
export const leasePort = (portsInUse: ReadonlyArray<number>): Option.Option<number> => {
  const occupied = new Set(portsInUse);
  return Option.fromNullishOr(
    Array.from(
      { length: servePortRange.last - servePortRange.first + 1 },
      (_, index) => servePortRange.first + index,
    ).find((port) => !occupied.has(port)),
  );
};

export const TailscaleServeProps = S.Struct({});
export type TailscaleServeProps = typeof TailscaleServeProps.Type;

export interface TailscaleServe extends Alchemy.Resource<
  "Tailscale.Serve",
  TailscaleServeProps,
  { id: string; port: number; backendPort: number; url: string }
> {}
export const TailscaleServe = Alchemy.Resource<TailscaleServe>("Tailscale.Serve");

export class TailscaleServeError extends S.TaggedError<TailscaleServeError>()(
  "TailscaleServeError",
  {
    operation: S.String,
    detail: S.String,
  },
) {
  override get message() {
    return `Tailscale Serve ${this.operation}: ${this.detail}`;
  }
}

const commandOutput = Effect.fn("TailscaleServe.commandOutput")(function* (
  args: ReadonlyArray<string>,
) {
  const spawner = yield* ChildProcessSpawner;
  const handle = yield* spawner.spawn(
    ChildProcess.make("tailscale", args, { stdout: "pipe", stderr: "pipe" }),
  );
  const [stdout, stderr, code] = yield* Effect.all(
    [
      Stream.mkString(Stream.decodeText(handle.stdout)),
      Stream.mkString(Stream.decodeText(handle.stderr)),
      handle.exitCode,
    ],
    { concurrency: "unbounded" },
  );
  if (code !== 0)
    return yield* new TailscaleServeError({ operation: args.join(" "), detail: stderr.trim() });
  return stdout;
}, Effect.scoped);

const decodeCommand = <A extends S.Constraint>(schema: A, args: ReadonlyArray<string>) =>
  commandOutput(args).pipe(
    Effect.flatMap((text) =>
      S.decodeUnknownEffect(S.fromJsonString(schema))(text).pipe(
        Effect.mapError(
          (cause) => new TailscaleServeError({ operation: args.join(" "), detail: cause.message }),
        ),
      ),
    ),
  );

const ensureServed = (port: number, backend: number) =>
  commandOutput(["serve", "--bg", `--https=${port}`, `http://127.0.0.1:${backend}`]).pipe(
    Effect.asVoid,
  );

export const TailscaleServeProvider = Provider.effect(
  TailscaleServe,
  Effect.succeed(
    TailscaleServe.Provider.of({
      list: () => Effect.succeed([]),
      stables: ["id"],
      reconcile: Effect.fn(function* ({ output, fqn }) {
        const status = yield* decodeCommand(ServeStatus, ["serve", "status", "--json"]);
        const port = yield* Option.match(
          output === undefined
            ? leasePort(Object.keys(status.TCP).map(Number))
            : Option.some(output.port),
          {
            onNone: () =>
              Effect.fail(
                new TailscaleServeError({
                  operation: "lease",
                  detail: "ports 9000-9099 are all in use",
                }),
              ),
            onSome: Effect.succeed,
          },
        );
        const hostname = yield* decodeCommand(TailscaleStatus, ["status", "--json"]).pipe(
          Effect.map((value) => value.Self.DNSName.replace(/\.$/, "")),
        );
        const target = `http://127.0.0.1:${backendPort(port)}`;
        const ownership = serveOwnership(status.Web, port, target);
        if (ownership._tag === "Conflict") {
          return yield* new TailscaleServeError({
            operation: "reconcile",
            detail: `port ${port} is already served by ${ownership.target}`,
          });
        }
        if (ownership._tag === "Missing") {
          yield* ensureServed(port, backendPort(port));
        }
        return {
          id: fqn,
          port,
          backendPort: backendPort(port),
          url: `https://${hostname}:${port}`,
        };
      }),
      delete: Effect.fn(function* ({ output }) {
        const status = yield* decodeCommand(ServeStatus, ["serve", "status", "--json"]);
        const target = `http://127.0.0.1:${backendPort(output.port)}`;
        if (serveOwnership(status.Web, output.port, target)._tag === "Owned") {
          yield* commandOutput(["serve", `--https=${output.port}`, "off"]);
        }
      }),
      read: ({ output }) => Effect.succeed(output),
    }),
  ),
);
