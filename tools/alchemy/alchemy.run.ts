import * as Alchemy from "alchemy";
import * as Config from "effect/Config";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Arr from "effect/Array";
import * as Option from "effect/Option";
import * as Match from "effect/Match";
import { FetchHttpClient } from "effect/http";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { NomadJob, NomadJobProvider } from "./src/NomadJob.ts";
import type { NomadJob as NomadJobResource } from "./src/NomadJob.ts";
import { PostgresDatabase, PostgresDatabaseProvider } from "./src/PostgresDatabase.ts";
import type { PostgresDatabase as PostgresDatabaseResource } from "./src/PostgresDatabase.ts";
import { ValkeyAccess, ValkeyAccessProvider } from "./src/ValkeyAccess.ts";
import type { ValkeyAccess as ValkeyAccessResource } from "./src/ValkeyAccess.ts";
import {
  AdminCredential,
  AdminCredentialProvider,
} from "./src/AdminCredential.ts";
import * as NomadLive from "./src/Nomad.ts";
import * as Cartridge from "./src/Cartridge.ts";
import { Job, ExpandedJob, ExpandedSecretReference, SecretReference } from "./src/Job.ts";
import * as OperationHistory from "./src/OperationJournal.ts";
import { OpenBao } from "./src/OpenBao.ts";

type DeployedService = {
  readonly name: string;
  readonly resource: NomadJobResource;
};

type DeployedValkeyAccess = {
  readonly name: string;
  // The Valkey service name, which is also its Nomad service name.
  readonly server: string;
  readonly resource: ValkeyAccessResource;
};

type DeployedPostgresDatabase = {
  readonly role: string;
  readonly credentialPath: string;
  readonly resource: PostgresDatabaseResource;
};

type DeployedState = {
  readonly services: ReadonlyArray<DeployedService>;
  readonly valkeyAccesses: ReadonlyArray<DeployedValkeyAccess>;
  readonly postgresDatabases: ReadonlyArray<DeployedPostgresDatabase>;
  readonly outputs: ReadonlyArray<{ kind: string; id: string; name: string }>;
};

const resolveConnections = (
  service: ExpandedJob,
  state: DeployedState,
) =>
  Effect.forEach(service.connections, (connection) =>
    Option.match(
      Arr.findFirst(state.services, (entry) => entry.name === connection.service),
      {
        onNone: () => Effect.die(new Error(`unresolved dependency '${connection.service}'`)),
        onSome: (provider) => Effect.succeed({ ...connection, service: provider.resource.id }),
      },
    ),
  );

const resolveSecrets = (
  service: ExpandedJob,
  state: DeployedState,
  extraSecrets: ReadonlyArray<ExpandedSecretReference>,
) =>
  Effect.forEach([...(service.secrets ?? []), ...extraSecrets], (secret) =>
    Match.value(secret).pipe(
      Match.when({ _tag: "ValkeyCredentials" }, (value) =>
        Option.match(
          Arr.findFirst(state.valkeyAccesses, (entry) => entry.name === value.access),
          {
            onNone: () => Effect.die(new Error(`unresolved Valkey access '${value.access}'`)),
            onSome: (access) =>
              Effect.succeed<SecretReference>({
                _tag: "ValkeyCredentials",
                access: value.access,
                credentialPath: access.resource.credentialPath,
                usernameEnv: value.usernameEnv,
                passwordEnv: value.passwordEnv,
                url:
                  value.url === undefined
                    ? undefined
                    : { env: value.url.env, server: access.server },
              }),
          },
        ),
      ),
      Match.when({ _tag: "PostgresCredentials" }, (value) =>
        Option.match(
          Arr.findFirst(state.postgresDatabases, (entry) => entry.role === value.role),
          {
            onNone: () => Effect.die(new Error(`unresolved PostgreSQL role '${value.role}'`)),
            onSome: (database) =>
              Effect.succeed<SecretReference>({
                _tag: "PostgresCredentials",
                role: value.role,
                credentialPath: database.credentialPath,
                usernameEnv: value.usernameEnv,
                passwordEnv: value.passwordEnv,
                url:
                  value.url === undefined
                    ? undefined
                    : {
                        env: value.url.env,
                        server: database.resource.server,
                        database: database.resource.name,
                      },
              }),
          },
        ),
      ),
      Match.when({ _tag: "KvSecret" }, (s) => Effect.succeed<SecretReference>(s)),
      Match.exhaustive,
    ),
  );

const declareJob = (
  kind: string,
  service: ExpandedJob,
  state: DeployedState,
  extraSecrets: ReadonlyArray<ExpandedSecretReference>,
) =>
  Effect.gen(function* () {
    const connections = yield* resolveConnections(service, state);
    const secrets = yield* resolveSecrets(service, state, extraSecrets);
    const resource = yield* NomadJob(service.name, {
      ...service,
      connections,
      secrets: secrets.length === 0 ? undefined : secrets,
    });
    const next: DeployedState = {
      ...state,
      services: Arr.append(state.services, { name: service.name, resource }),
      outputs: Arr.append(state.outputs, { kind, id: resource.id, name: service.name }),
    };
    return next;
  });

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
    const deployed = yield* Effect.reduce(
      resources,
      () => ({
        services: Arr.empty<DeployedService>(),
        valkeyAccesses: Arr.empty<DeployedValkeyAccess>(),
        postgresDatabases: Arr.empty<DeployedPostgresDatabase>(),
        outputs: Arr.empty<{ kind: string; id: string; name: string }>(),
      }),
      (state, declaration) =>
        Match.value(declaration).pipe(
          Match.when({ _tag: "NomadService" }, ({ service }) =>
            declareJob("NomadService", service, state, []),
          ),
          Match.when({ _tag: "PostgresDatabase" }, ({ database }) =>
            Effect.gen(function* () {
              const resource = yield* PostgresDatabase(database.resourceName, database);
              return {
                ...state,
                postgresDatabases: Arr.appendAll(state.postgresDatabases, [
                  { role: database.credentialRole, credentialPath: resource.credentialPath, resource },
                  { role: database.migrationCredentialRole, credentialPath: resource.migrationCredentialPath, resource },
                ]),
                outputs: Arr.append(state.outputs, {
                  kind: "PostgresDatabase",
                  id: resource.id,
                  name: database.name,
                }),
              };
            }),
          ),
          Match.tag("PostgresServer", "ValkeyServer", (declaration) =>
            Effect.gen(function* () {
              const service = declaration.service;
              const config = {
                PostgresServer: { engine: "postgres" as const, env: "POSTGRES_PASSWORD", kind: "PostgresServer" },
                ValkeyServer: { engine: "valkey" as const, env: "VALKEY_ADMIN_PASSWORD", kind: "ValkeyServer" },
              }[declaration._tag];
              const adminCredential = yield* AdminCredential(service.name, {
                engine: config.engine,
                server: service.name,
              });
              const adminSecret = {
                _tag: "KvSecret" as const,
                path: adminCredential.path,
                key: "password",
                env: config.env,
              };
              return yield* declareJob(config.kind, service, state, [adminSecret]);
            }),
          ),
          Match.when({ _tag: "ValkeyAccess" }, ({ access }) =>
            Effect.gen(function* () {
              const resource = yield* ValkeyAccess(access.resourceName, access);
              return {
                ...state,
                valkeyAccesses: Arr.append(state.valkeyAccesses, {
                  name: access.resourceName,
                  server: access.server,
                  resource,
                }),
                outputs: Arr.append(state.outputs, {
                  kind: "ValkeyAccess",
                  id: resource.id,
                  name: access.resourceName,
                }),
              };
            }),
          ),
          Match.exhaustive,
        ),
    );
    return { resources: deployed.outputs };
  }),
);

export default stack;
