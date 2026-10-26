import * as Layer from "effect/Layer";
import { FetchHttpClient } from "effect/http";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { NomadJobProvider } from "./NomadJob.ts";
import { PostgresDatabaseProvider } from "./PostgresDatabase.ts";
import { ValkeyAccessProvider } from "./ValkeyAccess.ts";
import { AdminCredentialProvider } from "./AdminCredential.ts";
import * as NomadLive from "./Nomad.ts";
import * as OperationHistory from "./OperationJournal.ts";
import { OpenBao } from "./OpenBao.ts";

/** Providers and their shared runtime dependencies for both normal and state-only stacks. */
export const providers = Layer.mergeAll(
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
