/**
 * The slice of a cartridge.json that `ops dev db` reads: the app name, postgres entries, and each
 * service's environment and PostgresCredentials. Other keys (image, routes, …) are ignored, so a
 * deployable cartridge and an image-less local one both decode. Deploy paths keep using
 * AppCartridge, which still requires image.
 */
import * as Config from "effect/Config";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as S from "effect/Schema";
import { AppName, PostgresEntry } from "../Cartridge.ts";
import {
  CartridgeEnvironmentEntry,
  CartridgeSecretReference,
  cartridgeArray,
  PostgresCredentialsDeclaration,
} from "../Job.ts";

const DevDbMigrate = S.Struct({
  secrets: cartridgeArray(CartridgeSecretReference),
});

const DevDbService = S.Struct({
  environment: cartridgeArray(CartridgeEnvironmentEntry),
  secrets: cartridgeArray(CartridgeSecretReference),
  migrate: S.optionalKey(DevDbMigrate),
});

export const DevDbCartridge = S.Struct({
  name: AppName,
  postgres: cartridgeArray(PostgresEntry),
  services: S.Array(DevDbService),
}).check(
  S.makeFilter((cartridge) => {
    const issues: Array<string> = [];
    const databases = new Set(cartridge.postgres.map((entry) => entry.database));
    for (const service of cartridge.services) {
      for (const secret of [...service.secrets, ...(service.migrate?.secrets ?? [])]) {
        if (secret._tag !== "PostgresCredentials") continue;
        if (!databases.has(secret.database)) {
          issues.push(
            `PostgresCredentials references database '${secret.database}' not in \`postgres\``,
          );
        }
      }
    }
    return issues.length === 0 ? undefined : issues;
  }),
);
export type DevDbCartridge = typeof DevDbCartridge.Type;

export const isPostgresCredentials = (
  secret: CartridgeSecretReference,
): secret is typeof PostgresCredentialsDeclaration.Type => secret._tag === "PostgresCredentials";

/** Read cartridge.json for ops dev db; excess keys (including image) are ignored. */
export const decodeDevDbFile = Effect.fn("devdb.decodeDevDbFile")(function* (path: string) {
  const fs = yield* FileSystem.FileSystem;
  const contents = yield* fs.readFileString(path).pipe(
    Effect.mapError(
      (cause) =>
        new Config.ConfigError(
          new ConfigProvider.SourceError({
            message: `Could not read Alchemy cartridge at '${path}'`,
            cause,
          }),
        ),
    ),
  );
  return yield* S.decodeUnknownEffect(S.fromJsonString(DevDbCartridge))(contents).pipe(
    Effect.mapError((cause) => new Config.ConfigError(cause)),
  );
});
