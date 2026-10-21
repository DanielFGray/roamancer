import * as Config from "effect/Config";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";
import { ReleaseSetProps } from "./ReleaseJob.ts";

const ReleaseManifest = Schema.Struct({
  apiVersion: Schema.Literals(["server-ansible/releases-v1"]),
  releaseSet: ReleaseSetProps,
});

/** Load a project's declarative release selection. */
export const load = Effect.fn(function* () {
  const path = yield* Config.String("ALCHEMY_RELEASE_SET");
  const fs = yield* FileSystem.FileSystem;
  const contents = yield* fs.readFileString(path).pipe(
    Effect.mapError(
      (cause) =>
        new Config.ConfigError(
          new ConfigProvider.SourceError({
            message: `Could not read release manifest at '${path}'`,
            cause,
          }),
        ),
    ),
  );
  return yield* Schema.decodeUnknownEffect(Schema.fromJsonString(ReleaseManifest), {
    onExcessProperty: "error",
  })(contents).pipe(
    Effect.mapError(
      (cause) =>
        new Config.ConfigError(
          new ConfigProvider.SourceError({
            message: `Could not decode release manifest at '${path}'`,
            cause,
          }),
        ),
    ),
    Effect.map((manifest) => manifest.releaseSet),
  );
});
