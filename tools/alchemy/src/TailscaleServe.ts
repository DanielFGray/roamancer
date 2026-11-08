import * as Alchemy from "alchemy";
import * as Provider from "alchemy/Provider";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as S from "effect/Schema";
import { ChildProcess } from "effect/process";
import { ChildProcessSpawner } from "effect/process/ChildProcessSpawner";
import * as Stream from "effect/Stream";
import { tailnetEntrypoint } from "./Job.ts";
import { Nomad } from "./Nomad.ts";
import { dependencyRegistrationRetry, firstServiceLocation } from "./ServiceRegistration.ts";

export const TailscaleStatus = S.Struct({
  Self: S.Struct({ DNSName: S.NonEmptyString }),
});
export type TailscaleStatus = typeof TailscaleStatus.Type;

// Tailscale omits TCP and Web when no entry is served, so `{}` means an empty config.
// Each TCP entry sets only the fields of its kind (omitempty): an HTTPS route carries
// HTTPS, and a raw forward carries TCPForward and no HTTPS.
export const ServeStatus = S.Struct({
  TCP: S.Record(
    S.String.check(S.isPattern(/^[0-9]+$/)),
    S.Struct({ HTTPS: S.optionalKey(S.Boolean), TCPForward: S.optionalKey(S.String) }),
  ).pipe(S.withDecodingDefaultKey(Effect.succeed({}))),
  Web: S.Record(
    S.String,
    S.Struct({ Handlers: S.Struct({ "/": S.Struct({ Proxy: S.String }) }) }),
  ).pipe(S.withDecodingDefaultKey(Effect.succeed({}))),
});
export type ServeStatus = typeof ServeStatus.Type;
export type ServeWeb = ServeStatus["Web"];

/** The target that Serve proxies the leased HTTPS port to; none when the port serves nothing. */
export const servedTarget = (web: ServeWeb, port: number): Option.Option<string> =>
  Option.map(
    Arr.findFirst(Object.entries(web), ([address]) => address.endsWith(`:${port}`)),
    ([, entry]) => entry.Handlers["/"].Proxy,
  );

export const servePortRange: { readonly first: number; readonly last: number } = {
  first: 9000,
  last: 9099,
};

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

export const TailscaleServeProps = S.Struct({
  // The path before each request, which tells Traefik the job (Job.tailnetPath).
  path: S.String,
});
export type TailscaleServeProps = typeof TailscaleServeProps.Type;

export interface TailscaleServe extends Alchemy.Resource<
  "Tailscale.Serve",
  TailscaleServeProps,
  { id: string; port: number; url: string; target: string }
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

// Serve keeps one handler per mount, so serving a port again replaces its target.
const ensureServed = (port: number, target: string) =>
  commandOutput(["serve", "--bg", `--https=${port}`, target]).pipe(Effect.asVoid);

/**
 * The Nomad service of Traefik, which serves the tailnet entrypoint (platform/ingress).
 * Serve reaches it at the LAN address that Nomad registers for it.
 */
export const ingressService = "traefik";

/**
 * A leased HTTPS port on the control host that forwards to Traefik's tailnet entrypoint,
 * under the job's path. Traefik then finds the job on any node through its service tags.
 */
export const TailscaleServeProvider = Provider.effect(
  TailscaleServe,
  Effect.gen(function* () {
    const nomad = yield* Nomad;
    return TailscaleServe.Provider.of({
      list: () => Effect.succeed([]),
      stables: ["id"],
      reconcile: Effect.fn(function* ({ news, output, fqn }) {
        const status = yield* decodeCommand(ServeStatus, ["serve", "status", "--json"]);
        // A recorded port stays this resource's lease, whatever it serves now.
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
        const ingress = yield* firstServiceLocation(
          ingressService,
          nomad.service(ingressService),
          dependencyRegistrationRetry,
        ).pipe(
          Effect.mapError(
            (cause) =>
              new TailscaleServeError({ operation: "find ingress", detail: cause.message }),
          ),
        );
        const target = `http://${ingress.Address}:${tailnetEntrypoint.port}${news.path}`;
        const hostname = yield* decodeCommand(TailscaleStatus, ["status", "--json"]).pipe(
          Effect.map((value) => value.Self.DNSName.replace(/\.$/, "")),
        );
        if (Option.getOrUndefined(servedTarget(status.Web, port)) !== target) {
          yield* ensureServed(port, target);
        }
        return { id: fqn, port, url: `https://${hostname}:${port}`, target };
      }),
      delete: Effect.fn(function* ({ output }) {
        const status = yield* decodeCommand(ServeStatus, ["serve", "status", "--json"]);
        if (Option.getOrUndefined(servedTarget(status.Web, output.port)) === output.target) {
          yield* commandOutput(["serve", `--https=${output.port}`, "off"]);
        }
      }),
      read: ({ output }) => Effect.succeed(output),
    });
  }),
);
