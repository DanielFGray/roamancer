import * as Alchemy from "alchemy";
import * as Config from "effect/Config";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { FetchHttpClient } from "effect/http";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { NomadJob, NomadJobProvider } from "./src/NomadJob.ts";
import { PostgresDatabase, PostgresDatabaseProvider } from "./src/PostgresDatabase.ts";
import { ValkeyAccess, ValkeyAccessProvider } from "./src/ValkeyAccess.ts";
import {
  AdminCredential,
  AdminCredentialProvider,
} from "./src/AdminCredential.ts";
import * as NomadLive from "./src/Nomad.ts";
import * as Cartridge from "./src/Cartridge.ts";
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
    ),
  ),
  Layer.orDie,
);

const stack = Alchemy.Stack(
  "cartridge",
  { providers, state: Alchemy.localState() },
  Effect.gen(function* () {
    const cartridge = yield* Cartridge.load();
    const stage = yield* Alchemy.Stage;
    if (stage !== cartridge.name) {
      return yield* Effect.fail(
        new Config.ConfigError(
          new ConfigProvider.SourceError({
            message: `stage mismatch: expected --stage ${cartridge.name}, got ${stage}`,
          }),
        ),
      );
    }
    const resources = Cartridge.expand(cartridge);
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
