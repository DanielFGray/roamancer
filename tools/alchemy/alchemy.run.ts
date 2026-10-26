import * as Alchemy from "alchemy";
import * as Config from "effect/Config";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { FetchHttpClient } from "effect/http";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { NomadJob, NomadJobProvider } from "./src/NomadJob.ts";
import { PostgresDatabase, PostgresDatabaseProvider } from "./src/PostgresDatabase.ts";
import { ValkeyAccess, ValkeyAccessProvider } from "./src/ValkeyAccess.ts";
import { AdminCredential, AdminCredentialProvider } from "./src/AdminCredential.ts";
import * as NomadLive from "./src/Nomad.ts";
import * as Cartridge from "./src/Cartridge.ts";
import * as StagedCartridge from "./src/StagedCartridge.ts";
import * as OperationHistory from "./src/OperationJournal.ts";
import { OpenBao } from "./src/OpenBao.ts";
import { compose } from "./src/Compose.ts";

const providers = Layer.mergeAll(
  NomadJobProvider(),
  PostgresDatabaseProvider(),
  ValkeyAccessProvider(),
  AdminCredentialProvider(),
).pipe(
  Layer.provide(
    Layer.mergeAll(
      NomadLive.layer(),
      OperationHistory.layer(),
      OpenBao.layer,
      FetchHttpClient.layer,
      NodeCrypto.layer,
      NodeServices.layer,
    ),
  ),
  Layer.orDie,
);

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
