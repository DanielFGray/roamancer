/**
 * The installation's facts, as `ops` needs them: the site folder that OPS_SITE names and the
 * control host in its site.toml. The nixos flakes read the whole file when Nix builds a host;
 * this reads only what the workstation commands use.
 */
import { Config, Context, Effect, FileSystem, Layer, Option, Path, Schema as S } from "effect";
import { Toml } from "effect/encoding";
import { OpsError } from "./Exec.ts";

const SiteFile = S.Struct({ cluster: S.Struct({ server: S.String }) });

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

    /** The control host: OPS_HOST when set, otherwise `cluster.server` of the site.toml. */
    const host = Effect.gen(function* () {
      const override = yield* Config.option(Config.String("OPS_HOST"));
      if (Option.isSome(override)) return override.value;
      const file = path.join(yield* folder, "site.toml");
      const text = yield* fs
        .readFileString(file)
        .pipe(Effect.mapError((error) => new OpsError({ message: error.message })));
      const parsed = yield* Effect.try({
        try: () => Toml.parse(text),
        catch: (cause) => new OpsError({ message: `${file} is not valid TOML: ${cause}` }),
      });
      const site = yield* S.decodeUnknownEffect(SiteFile)(parsed).pipe(
        Effect.mapError(() => new OpsError({ message: `cluster.server is not set in ${file}` })),
      );
      return site.cluster.server;
    });

    return { folder, host };
  }),
}) {
  static readonly layer = Layer.effect(this, this.make);
}
