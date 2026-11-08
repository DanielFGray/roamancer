/**
 * The installation's facts, as `ops` needs them: the site folder that OPS_SITE names and the
 * control host in its site.toml. The nixos flakes read the whole file when Nix builds a host;
 * this reads only what the workstation commands use.
 */
import { Config, Context, Effect, FileSystem, Layer, Option, Path, Schema as S } from "effect";
import { Toml } from "effect/encoding";
import { OpsError } from "./Exec.ts";

const SiteFile = S.Struct({
  cluster: S.Struct({
    server: S.String,
    lanAddress: S.String,
    // Only `ops image` reads the registry, so other commands work without these.
    registryName: S.optionalKey(S.String),
    registryPort: S.optionalKey(S.Number),
    nodes: S.optionalKey(S.Record(S.String, S.String)),
  }),
  build: S.optionalKey(S.Struct({ node: S.String })),
  devdb: S.optionalKey(S.Struct({ node: S.String })),
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
              message: `${file} must set cluster.server, cluster.lanAddress and, when present, [build] node and [devdb] node: ${cause}`,
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
     * The LAN address of the node in `[devdb] node`, where Nomad binds the dev Postgres
     * server's host port; the control host when the table is absent. The dev database
     * tunnel forwards to it through the control host. NixOS reads the same setting to put
     * the dev server's volume on that node, which pins the server there.
     */
    const devDbAddress = Effect.gen(function* () {
      const site = yield* siteFile;
      const node = site.devdb?.node ?? site.cluster.server;
      if (node === site.cluster.server) return site.cluster.lanAddress;
      const address = site.cluster.nodes?.[node];
      if (address === undefined) {
        return yield* new OpsError({
          message: `[devdb] node is '${node}', which [cluster.nodes] of site.toml does not list`,
        });
      }
      return address;
    });

    /** The cluster image registry, as `name:port`, which every machine reaches by that name. */
    const registry = Effect.gen(function* () {
      const { registryName, registryPort } = (yield* siteFile).cluster;
      if (registryName === undefined || registryPort === undefined) {
        return yield* new OpsError({
          message: "site.toml must set cluster.registryName and cluster.registryPort",
        });
      }
      return `${registryName}:${registryPort}`;
    });

    return { folder, host, buildNode, devDbAddress, registry };
  }),
}) {
  static readonly layer = Layer.effect(this, this.make);
}
