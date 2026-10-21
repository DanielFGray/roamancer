import * as Config from "effect/Config";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Arr from "effect/Array";
import * as Option from "effect/Option";
import * as Match from "effect/Match";
import * as Schema from "effect/Schema";
import { CartridgeJob } from "./Job.ts";
import { PostgresDatabaseProps } from "./PostgresDatabase.ts";
import { ValkeyAccessConfig } from "./ValkeyAccess.ts";

const NomadServiceDeclaration = Schema.TaggedStruct("NomadService", { service: CartridgeJob });
const PostgresDatabaseDeclaration = Schema.TaggedStruct("PostgresDatabase", {
  database: PostgresDatabaseProps,
});
const ValkeyServerDeclaration = Schema.TaggedStruct("ValkeyServer", { service: CartridgeJob });
const ValkeyAccessDeclaration = Schema.TaggedStruct("ValkeyAccess", {
  access: ValkeyAccessConfig,
});
const Resource = Schema.Union([
  NomadServiceDeclaration,
  ValkeyServerDeclaration,
  PostgresDatabaseDeclaration,
  ValkeyAccessDeclaration,
]);

export const Cartridge = Schema.Struct({
  apiVersion: Schema.Literals(["server-ansible/v1"]),
  resources: Schema.Array(Resource),
});
export type Cartridge = typeof Cartridge.Type;

const resourceOrderError = (resources: ReadonlyArray<typeof Resource.Type>) =>
  resources.reduce(
    (state, resource) =>
      Option.match(state.error, {
        onSome: () => state,
        onNone: () =>
          Match.value(resource).pipe(
            Match.when({ _tag: "NomadService" }, ({ service }) => {
              const duplicate = state.names.includes(service.name);
              const missingService = Arr.findFirst(
                service.connections,
                (connection) => !state.services.includes(connection.service),
              );
              const missingDatabaseRole = Option.match(Option.fromNullishOr(service.vault), {
                onNone: () => Option.none(),
                onSome: (vault) =>
                  Option.flatMap(
                    Arr.findFirst(vault.secrets, (secret) =>
                      Match.value(secret).pipe(
                        Match.when({ _tag: "KvSecret" }, () => false),
                        Match.when(
                          { _tag: "PostgresCredentials" },
                          (value) => !state.credentialRoles.includes(value.role),
                        ),
                        Match.when({ _tag: "ValkeyCredentials" }, () => false),
                        Match.exhaustive,
                      ),
                    ),
                    (secret) =>
                      Match.value(secret).pipe(
                        Match.when({ _tag: "KvSecret" }, () => Option.none<string>()),
                        Match.when({ _tag: "PostgresCredentials" }, (value) =>
                          Option.some(value.role),
                        ),
                        Match.when({ _tag: "ValkeyCredentials" }, () => Option.none<string>()),
                        Match.exhaustive,
                      ),
                  ),
              });
              const missingValkeyAccess = Option.match(Option.fromNullishOr(service.vault), {
                onNone: () => Option.none(),
                onSome: (vault) =>
                  Option.flatMap(
                    Arr.findFirst(vault.secrets, (secret) =>
                      Match.value(secret).pipe(
                        Match.when(
                          { _tag: "ValkeyCredentials" },
                          (value) => !state.valkeyAccesses.includes(value.access),
                        ),
                        Match.when({ _tag: "KvSecret" }, () => false),
                        Match.when({ _tag: "PostgresCredentials" }, () => false),
                        Match.exhaustive,
                      ),
                    ),
                    (secret) =>
                      Match.value(secret).pipe(
                        Match.when({ _tag: "ValkeyCredentials" }, (value) =>
                          Option.some(value.access),
                        ),
                        Match.when({ _tag: "KvSecret" }, () => Option.none<string>()),
                        Match.when({ _tag: "PostgresCredentials" }, () => Option.none<string>()),
                        Match.exhaustive,
                      ),
                  ),
              });
              if (duplicate) {
                return {
                  ...state,
                  error: Option.some(`Duplicate resource name '${service.name}'`),
                };
              }
              return Option.match(missingService, {
                onSome: (connection) => ({
                  ...state,
                  error: Option.some(
                    `Service '${service.name}' must follow its service dependency '${connection.service}'`,
                  ),
                }),
                onNone: () =>
                  Option.match(missingDatabaseRole, {
                    onSome: (role) => ({
                      ...state,
                      error: Option.some(
                        `Service '${service.name}' must follow database role '${role}'`,
                      ),
                    }),
                    onNone: () =>
                      Option.match(missingValkeyAccess, {
                        onSome: (access) => ({
                          ...state,
                          error: Option.some(
                            `Service '${service.name}' must follow Valkey access '${access}'`,
                          ),
                        }),
                        onNone: () => ({
                          ...state,
                          names: Arr.append(state.names, service.name),
                          services: Arr.append(state.services, service.name),
                        }),
                      }),
                  }),
              });
            }),
            Match.when({ _tag: "PostgresDatabase" }, ({ database }) => {
              if (state.names.includes(database.resourceName)) {
                return {
                  ...state,
                  error: Option.some(`Duplicate resource name '${database.resourceName}'`),
                };
              }
              if (!state.services.includes(database.server)) {
                return {
                  ...state,
                  error: Option.some(
                    `Database '${database.name}' must follow its PostgreSQL service '${database.server}'`,
                  ),
                };
              }
              if (state.credentialRoles.includes(database.credentialRole)) {
                return {
                  ...state,
                  error: Option.some(
                    `Duplicate PostgreSQL credential role '${database.credentialRole}'`,
                  ),
                };
              }
              return {
                ...state,
                names: Arr.append(state.names, database.resourceName),
                credentialRoles: Arr.append(state.credentialRoles, database.credentialRole),
              };
            }),
            Match.when({ _tag: "ValkeyServer" }, ({ service }) => {
              if (state.names.includes(service.name)) {
                return {
                  ...state,
                  error: Option.some(`Duplicate resource name '${service.name}'`),
                };
              }
              return Option.match(Option.fromNullishOr(service.vault), {
                onNone: () => ({
                  ...state,
                  error: Option.some(
                    `Valkey service '${service.name}' must declare a Nomad workload identity role`,
                  ),
                }),
                onSome: () => ({
                  ...state,
                  names: Arr.append(state.names, service.name),
                  services: Arr.append(state.services, service.name),
                  valkeyServers: Arr.append(state.valkeyServers, service.name),
                }),
              });
            }),
            Match.when({ _tag: "ValkeyAccess" }, ({ access }) => {
              if (state.names.includes(access.resourceName)) {
                return {
                  ...state,
                  error: Option.some(`Duplicate resource name '${access.resourceName}'`),
                };
              }
              if (!state.valkeyServers.includes(access.server)) {
                return {
                  ...state,
                  error: Option.some(
                    `Valkey access '${access.resourceName}' must follow its service '${access.server}'`,
                  ),
                };
              }
              if (state.valkeyAccesses.includes(access.resourceName)) {
                return {
                  ...state,
                  error: Option.some(`Duplicate Valkey access '${access.resourceName}'`),
                };
              }
              return {
                ...state,
                names: Arr.append(state.names, access.resourceName),
                valkeyAccesses: Arr.append(state.valkeyAccesses, access.resourceName),
              };
            }),
            Match.exhaustive,
          ),
      }),
    {
      names: Arr.empty<string>(),
      services: Arr.empty<string>(),
      credentialRoles: Arr.empty<string>(),
      valkeyAccesses: Arr.empty<string>(),
      valkeyServers: Arr.empty<string>(),
      error: Option.none<string>(),
    },
  ).error;

/** Read and validate the project-owned workload declaration. */
export const load = Effect.fn(function* () {
  const path = yield* Config.String("ALCHEMY_CARTRIDGE");
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
  const cartridge = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Cartridge), {
    onExcessProperty: "error",
  })(contents).pipe(Effect.mapError((cause) => new Config.ConfigError(cause)));
  return yield* Option.match(resourceOrderError(cartridge.resources), {
    onNone: () => Effect.succeed(cartridge),
    onSome: (message) =>
      Effect.fail(new Config.ConfigError(new ConfigProvider.SourceError({ message }))),
  });
});
