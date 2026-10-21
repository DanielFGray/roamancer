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
  ValkeyAdminCredential,
  ValkeyAdminCredentialProvider,
} from "./src/ValkeyAdminCredential.ts";
import * as NomadLive from "./src/Nomad.ts";
import * as Cartridge from "./src/Cartridge.ts";
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
  readonly resource: PostgresDatabaseResource;
};

const providers = Layer.mergeAll(
  NomadJobProvider(),
  PostgresDatabaseProvider(),
  ValkeyAccessProvider(),
  ValkeyAdminCredentialProvider(),
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
  "Noneuclid",
  { providers, state: Alchemy.localState() },
  Effect.gen(function* () {
    const { resources } = yield* Cartridge.load();
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
            Effect.gen(function* () {
              const connections = yield* Effect.forEach(service.connections, (connection) =>
                Option.match(
                  Arr.findFirst(state.services, (entry) => entry.name === connection.service),
                  {
                    onNone: () =>
                      Effect.fail(
                        new Config.ConfigError(
                          new ConfigProvider.SourceError({
                            message: `Service '${service.name}' has unresolved dependency '${connection.service}'`,
                          }),
                        ),
                      ),
                    onSome: (provider) =>
                      Effect.succeed({ ...connection, service: provider.resource.id }),
                  },
                ),
              );
              const resource = yield* Option.match(Option.fromNullishOr(service.vault), {
                onNone: () => NomadJob(service.name, { ...service, connections }),
                onSome: (vault) =>
                  Effect.gen(function* () {
                    const secrets = yield* Effect.forEach(vault.secrets, (secret) =>
                      Match.value(secret).pipe(
                        Match.when({ _tag: "ValkeyCredentials" }, (value) =>
                          Option.match(
                            Arr.findFirst(
                              state.valkeyAccesses,
                              (entry) => entry.name === value.access,
                            ),
                            {
                              onNone: () =>
                                Effect.fail(
                                  new Config.ConfigError(
                                    new ConfigProvider.SourceError({
                                      message: `Service '${service.name}' has unresolved Valkey access '${value.access}'`,
                                    }),
                                  ),
                                ),
                              onSome: (access) =>
                                Effect.succeed({
                                  ...value,
                                  credentialPath: access.resource.credentialPath,
                                  ...(value.url === undefined
                                    ? {}
                                    : { url: { env: value.url.env, server: access.server } }),
                                }),
                            },
                          ),
                        ),
                        Match.when({ _tag: "PostgresCredentials" }, (value) =>
                          Option.match(
                            Arr.findFirst(
                              state.postgresDatabases,
                              (entry) => entry.role === value.role,
                            ),
                            {
                              onNone: () =>
                                Effect.fail(
                                  new Config.ConfigError(
                                    new ConfigProvider.SourceError({
                                      message: `Service '${service.name}' has unresolved PostgreSQL role '${value.role}'`,
                                    }),
                                  ),
                                ),
                              onSome: (database) =>
                                Effect.succeed({
                                  ...value,
                                  credentialPath: database.resource.credentialPath,
                                  ...(value.url === undefined
                                    ? {}
                                    : {
                                        url: {
                                          env: value.url.env,
                                          server: database.resource.server,
                                          database: database.resource.name,
                                        },
                                      }),
                                }),
                            },
                          ),
                        ),
                        Match.when({ _tag: "KvSecret" }, Effect.succeed),
                        Match.exhaustive,
                      ),
                    );
                    return yield* NomadJob(service.name, {
                      ...service,
                      connections,
                      vault: { ...vault, secrets },
                    });
                  }),
              });
              return {
                ...state,
                services: Arr.append(state.services, { name: service.name, resource }),
                outputs: Arr.append(state.outputs, {
                  kind: "NomadService",
                  id: resource.id,
                  name: service.name,
                }),
              };
            }),
          ),
          Match.when({ _tag: "PostgresDatabase" }, ({ database }) =>
            Effect.gen(function* () {
              const server = yield* Option.match(
                Arr.findFirst(state.services, (entry) => entry.name === database.server),
                {
                  onNone: () =>
                    Effect.fail(
                      new Config.ConfigError(
                        new ConfigProvider.SourceError({
                          message: `Database '${database.name}' has unresolved service '${database.server}'`,
                        }),
                      ),
                    ),
                  onSome: Effect.succeed,
                },
              );
              const resource = yield* PostgresDatabase(database.resourceName, {
                ...database,
                server: server.resource.id,
              });
              return {
                ...state,
                postgresDatabases: Arr.append(state.postgresDatabases, {
                  role: database.credentialRole,
                  resource,
                }),
                outputs: Arr.append(state.outputs, {
                  kind: "PostgresDatabase",
                  id: resource.id,
                  name: database.name,
                }),
              };
            }),
          ),
          Match.when({ _tag: "ValkeyServer" }, ({ service }) =>
            Effect.gen(function* () {
              const adminCredential = yield* ValkeyAdminCredential(service.name, {
                server: service.name,
              });
              const vault = yield* Option.match(Option.fromNullishOr(service.vault), {
                onNone: () =>
                  Effect.fail(
                    new Config.ConfigError(
                      new ConfigProvider.SourceError({
                        message: `Valkey service '${service.name}' must declare a workload identity role`,
                      }),
                    ),
                  ),
                onSome: (config) =>
                  Effect.succeed({
                    role: config.role,
                    secrets: Arr.append(config.secrets, {
                      _tag: "KvSecret" as const,
                      path: adminCredential.path,
                      key: "password",
                      env: "VALKEY_ADMIN_PASSWORD",
                    }),
                  }),
              });
              const resource = yield* NomadJob(service.name, { ...service, vault });
              return {
                ...state,
                services: Arr.append(state.services, { name: service.name, resource }),
                outputs: Arr.append(state.outputs, {
                  kind: "ValkeyServer",
                  id: resource.id,
                  name: service.name,
                }),
              };
            }),
          ),
          Match.when({ _tag: "ValkeyAccess" }, ({ access }) =>
            Effect.gen(function* () {
              const server = yield* Option.match(
                Arr.findFirst(state.services, (entry) => entry.name === access.server),
                {
                  onNone: () =>
                    Effect.fail(
                      new Config.ConfigError(
                        new ConfigProvider.SourceError({
                          message: `Valkey access '${access.resourceName}' has unresolved service '${access.server}'`,
                        }),
                      ),
                    ),
                  onSome: Effect.succeed,
                },
              );
              const resource = yield* ValkeyAccess(access.resourceName, {
                ...access,
                server: server.resource.id,
              });
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
