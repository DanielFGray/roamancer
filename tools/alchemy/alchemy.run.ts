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
import * as Cartridge from "./src/Cartridge.ts";
import * as StagedCartridge from "./src/StagedCartridge.ts";
import { compose } from "./src/Compose.ts";

const stack = Alchemy.Stack(
  "cartridge",
  { providers, state: Alchemy.localState() },
  Effect.gen(function* () {
    // The stage names the cartridge: `alchemy deploy --stage giglist` deploys the
    // cartridge whose name is giglist, under apps/ or platform/. A stage of the form
    // `giglist-staged` deploys a staged instance of giglist instead: the same services
    // under suffixed names, on the candidate image, with no public route.
    const stage = yield* Alchemy.Stage;
    const resources = yield* Option.match(StagedCartridge.baseName(stage), {
      onNone: () =>
        Effect.gen(function* () {
          const { cartridge } = yield* Cartridge.find(".", stage);
          return Cartridge.expand(cartridge);
        }),
      onSome: (base) =>
        Effect.gen(function* () {
          // A staged stage has no default image: without one the run would deploy the
          // live image again, which is the opposite of what the stage asked for.
          const image = yield* Config.String("STAGED_IMAGE");
          const { cartridge } = yield* Cartridge.find(".", base);
          // The stack fails only with ConfigError; a refused cartridge is one.
          const staged = yield* StagedCartridge.staged(cartridge, image).pipe(
            Effect.mapError(
              (refusal) =>
                new Config.ConfigError(
                  new ConfigProvider.SourceError({ message: refusal.message }),
                ),
            ),
          );
          return Cartridge.expand(staged);
        }),
    });
    const deployed = yield* compose(resources, {
      NomadJob,
      PostgresDatabase,
      ValkeyAccess,
      AdminCredential,
    });
    return { resources: deployed.outputs };
  }),
);

export default stack;
