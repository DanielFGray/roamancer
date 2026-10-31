/**
 * The installation's facts, as `ops` needs them: the site folder that OPS_SITE names and the
 * control host in its site.toml. The nixos flakes read the whole file when Nix builds a host;
 * this reads only what the workstation commands use.
 */
import { Config, Context, Effect, FileSystem, Layer, Option, Path, Schema as S } from "effect";
import { Toml } from "effect/encoding";
import { OpsError } from "./Exec.ts";

const SiteFile = S.Struct({
  cluster: S.Struct({ server: S.String, lanAddress: S.String }),
  build: S.optionalKey(S.Struct({ node: S.String })),
});

export class Site extends Context.Service<Site>()("ops/Site", {
  make: Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;

    /** The absolute path of the site folder. */
    const folder = Config.String("OPS_SITE").pipe(
      Effect.mapError(
        () => new OpsError({ message: "set OPS_SITE to the folder that holds your site.toml" }),
      ),
      Effect.map((given) => path.resolve(given)),
    );

    const siteFile = Effect.gen(function* () {
      const file = path.join(yield* folder, "site.toml");
      const text = yield* fs
        .readFileString(file)
        .pipe(Effect.mapError((error) => new OpsError({ message: error.message })));
      const parsed = yield* Effect.try({
        try: () => Toml.parse(text),
        catch: (cause) => new OpsError({ message: `${file} is not valid TOML: ${cause}` }),
      });
      return yield* S.decodeUnknownEffect(SiteFile)(parsed).pipe(
        Effect.mapError(
          (cause) =>
            new OpsError({
              message: `${file} must set cluster.server, cluster.lanAddress and, when present, [build] node: ${cause}`,
            }),
        ),
      );
    });

    /** The control host: OPS_HOST when set, otherwise `cluster.server` of the site.toml. */
    const host = Effect.gen(function* () {
      const override = yield* Config.option(Config.String("OPS_HOST"));
      if (Option.isSome(override)) return override.value;
      return (yield* siteFile).cluster.server;
    });

    /**
     * The build node in `[build] node` of the site.toml, when set. Absence means the
     * workstation builds with Docker.
     */
    const buildNode = Effect.map(siteFile, (site) =>
      Option.fromNullishOr(site.build).pipe(Option.map((build) => build.node)),
    );

    /**
     * The server's LAN address, where Nomad binds the platform Postgres host port. The
     * dev database tunnel forwards to it through the control host.
     */
    const lanAddress = Effect.map(siteFile, (site) => site.cluster.lanAddress);

    return { folder, host, buildNode, lanAddress };
  }),
}) {
  static readonly layer = Layer.effect(this, this.make);
}
