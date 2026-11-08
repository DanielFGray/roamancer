import * as Alchemy from "alchemy";
import * as Config from "effect/Config";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { providers } from "./src/StackProviders.ts";
import { NomadJob } from "./src/NomadJob.ts";
import { PostgresDatabase } from "./src/PostgresDatabase.ts";
import { ValkeyAccess } from "./src/ValkeyAccess.ts";
import { AdminCredential } from "./src/AdminCredential.ts";
import { TailscaleServe } from "./src/TailscaleServe.ts";
import * as Cartridge from "./src/Cartridge.ts";
import * as Package from "./src/Package.ts";
import * as Deployments from "./src/Deployments.ts";
import * as StagedCartridge from "./src/StagedCartridge.ts";
import { compose } from "./src/Compose.ts";

const stack = Alchemy.Stack(
  "cartridge",
  { providers, state: Alchemy.localState() },
  Effect.gen(function* () {
    // The stage names the cartridge: `alchemy deploy --stage giglist` deploys the
    // cartridge whose name is giglist; Cartridge.resolve says where it comes from. A stage
    // of the form `giglist-staged` deploys a staged instance of giglist instead: the same services
    // under suffixed names, on the candidate image, with no public route.
    const stage = yield* Alchemy.Stage;
    // The app commit this deploy runs, sent by ops release, stage, promote and rollback.
    const revision = yield* Config.option(Config.String("REVISION"));
    const resources = yield* Option.match(StagedCartridge.baseName(stage), {
      onNone: () =>
        Effect.gen(function* () {
          const cartridge = yield* Cartridge.resolve(Package.root, stage);
          return Cartridge.expand(cartridge, revision);
        }),
      onSome: (base) =>
        Effect.gen(function* () {
          // A staged stage has no default image: without one the run would deploy the
          // live image again, which is the opposite of what the stage asked for.
          const image = yield* Config.String("STAGED_IMAGE");
          const cartridge = yield* Cartridge.resolve(Package.root, base);
          const deployments = yield* Deployments.Deployments;
          const released = Option.isSome(yield* deployments.latest(base));
          // The stack fails only with ConfigError; a refused cartridge is one.
          const staged = yield* StagedCartridge.staged(cartridge, image, { released }).pipe(
            Effect.mapError(
              (refusal) =>
                new Config.ConfigError(
                  new ConfigProvider.SourceError({ message: refusal.message }),
                ),
            ),
          );
          return Cartridge.expand(staged, revision);
        }),
    }).pipe(
      Effect.provide(Deployments.layer()),
      // The stack fails only with ConfigError; an unreadable deployment record is one.
      Effect.catchTags({
        PlatformError: (cause) =>
          Effect.fail(
            new Config.ConfigError(
              new ConfigProvider.SourceError({
                message: "Could not open the deployment record",
                cause,
              }),
            ),
          ),
        SqlError: (cause) =>
          Effect.fail(
            new Config.ConfigError(
              new ConfigProvider.SourceError({
                message: "Could not read the deployment record",
                cause,
              }),
            ),
          ),
        SchemaError: (cause) =>
          Effect.fail(
            new Config.ConfigError(
              new ConfigProvider.SourceError({
                message: "Could not decode the deployment record",
                cause,
              }),
            ),
          ),
      }),
    );
    // Each constructor needs its own provider; the union names them all, which inference cannot.
    const deployed = yield* compose<
      | Alchemy.Provider<NomadJob>
      | Alchemy.Provider<PostgresDatabase>
      | Alchemy.Provider<ValkeyAccess>
      | Alchemy.Provider<AdminCredential>
      | Alchemy.Provider<TailscaleServe>
    >(resources, {
      NomadJob,
      PostgresDatabase,
      ValkeyAccess,
      AdminCredential,
      TailscaleServe,
    }).pipe(
      // The stack fails only with ConfigError; an unresolved route reference is one.
      Effect.mapError(
        (error) =>
          new Config.ConfigError(new ConfigProvider.SourceError({ message: error.message })),
      ),
    );
    return {
      resources: deployed.outputs,
      tailnetUrls: deployed.tailnetServes.map((serve) => serve.resource.url),
    };
  }),
);

export default stack;
